// 首页登录态实时流（2026-11-09 张老师需求）：已登录用户访问首页，动态流/录像发现流
// 必须实时显示最新内容，不走 5 分钟数据缓存；访客路径保持原缓存+预热体系不变。
//
// ── 为什么不做「登录态直查」──
// 首页两条流的重建成本实测很高（发现流去重 SQL ~2.1s、新闻流 count 全扫 ~1.25s，
// 2026-10-26 慢 SQL 巡检；11-03「点首页卡几秒」即为直查时代）。登录用户每访直查
// 会把「首页卡几秒」原样带回，且与「热点统计必须挂 unstable_cache」性能铁律冲突。
//
// ── 方案：内容水位探测作缓存盐（watermark salted cache key）──
// 每条流配一个「水位探测」：只查「近 30 天窗口内」前台口径的最新痕迹（索引反扫
// 亚毫秒，探测挂 5s 进程内微缓存，同窗口内多请求共享一次查询）。探测值（最新
// id:create_time 串 + 窗口行数）作为盐拼进数据缓存的键——
// · 内容无变化 → 盐不变 → 命中原热缓存键（预热体系照常保温，零额外成本）；
// · 有新内容 → 盐变化 → 新键 miss → 该次登录访问阻塞重建一次，立即看到最新内容。
// 缓存键空间有界（盐只随真实内容变化，无法被请求参数伪造），垃圾条目靠 TTL 回收。
//
// ── 覆盖范围与兜底 ──
// · 动态流：水位=NEWS_HOME_TYPES ∩ 30 天窗口的最新 3 行 + 窗口行数。写入点全部经
//   publishNews 统一入口，水位必然变化；审核改判/删除类变化不改 news 行——由
//   refreshHomeNewsCache 的 tag 打脏兜底（两路径叠加）。
// · 录像发现流：水位=status<>0 录像 30 天窗口的最新 3 个 id + 窗口行数。上传、审核
//   通过/屏蔽（改 status）、封禁连坐都会移动水位或触发 tag 打脏。
// · 探测失败回退空盐 → 走访客键，页面照常渲染只是该流短暂不实时（5s TTL 自然恢复）。
//
// ⚠️ 本文件只允许服务端链路 import（page.tsx / route handler）；auth 走动态 import，
// 即使被误引入客户端 bundle 也不会把 next/headers 静态拖进编译（E394 同源陷阱）。

import { prisma } from "./db";
import { NEWS_HOME_TYPES, VIDEO_STATUS } from "./config";

/** 水位探测窗口（秒）：流按时间倒序，30 天前的变化对首屏无感（删除类由 tag 打脏兜底），
 *  窗口约束探测成本恒定（[type,createTime] / [createTime] 索引反扫窗口段） */
const WATERMARK_WINDOW_SECONDS = 30 * 24 * 3600;

/** 水位探测微缓存 TTL（秒）：内容变化后最迟 5s 在登录访问中体现 */
const WATERMARK_PROBE_TTL_SECONDS = 5;

const nowSec = () => Math.floor(Date.now() / 1000);

/** 通用微缓存（进程内）：探测查询亚毫秒级，5s 共享足够 */
const probeCache = new Map<string, { at: number; value: string }>();
async function probeCached(key: string, compute: () => Promise<string>): Promise<string> {
  const now = nowSec();
  const hit = probeCache.get(key);
  if (hit && now - hit.at < WATERMARK_PROBE_TTL_SECONDS) return hit.value;
  const value = await compute();
  if (probeCache.size > 500) probeCache.clear(); // 防膨胀：键空间有界，误清只是多一次探测
  probeCache.set(key, { at: now, value });
  return value;
}

/** 最新 3 行痕迹 (id:create_time) + 窗口行数 → 紧凑串作盐。
 *  头部新行代表「有没有新内容」，窗口行数兜底窗口内删除/屏蔽。 */
function wmString(ids: bigint[], cts: bigint[], count: number): string {
  return `${ids.map((id, i) => `${id}:${cts[i] ?? 0}`).join("|")}#${count}`;
}

/** 首页动态流水位（home 白名单口径；首创行/快照闸不进探测——那些行极低频且删除类
 *  变化由 tag 打脏兜底）。索引 [type,createTime] 反扫 30 天窗口。 */
async function newsWatermarkImpl(): Promise<string> {
  const cutoff = BigInt(nowSec() - WATERMARK_WINDOW_SECONDS);
  const where = { type: { in: NEWS_HOME_TYPES }, createTime: { gte: cutoff } };
  const [rows, count] = await Promise.all([
    prisma.news.findMany({
      where,
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
      take: 3,
      select: { id: true, createTime: true },
    }),
    prisma.news.count({ where }),
  ]);
  return wmString(
    rows.map((r) => r.id),
    rows.map((r) => r.createTime),
    count
  );
}

/** 首页录像发现流水位（status<>0 前台口径）：审核通过/屏蔽/封禁连坐都会移动水位。
 *  索引 [createTime] 反扫 30 天窗口。 */
async function videoWatermarkImpl(): Promise<string> {
  const cutoff = BigInt(nowSec() - WATERMARK_WINDOW_SECONDS);
  const where = { status: { not: VIDEO_STATUS.BANNED }, createTime: { gte: cutoff } };
  const [rows, count] = await Promise.all([
    prisma.video.findMany({
      where,
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
      take: 3,
      select: { id: true, createTime: true },
    }),
    prisma.video.count({ where }),
  ]);
  return wmString(
    rows.map((r) => r.id),
    rows.map((r) => r.createTime),
    count
  );
}

export function getNewsWatermark(): Promise<string> {
  return probeCached("news", newsWatermarkImpl);
}

export function getVideoWatermark(): Promise<string> {
  return probeCached("video", videoWatermarkImpl);
}

export interface FeedSalts {
  news: string;
  video: string;
}

/**
 * 按登录态取两条流的缓存盐（首页 SSR 与翻页 API 服务端共用；盐由服务端探测得出，
 * 客户端无法伪造）。未登录返回双空串＝走访客原键（与预热同键，路径零变化）。
 * 探测失败同样回退空串（页面照常渲染，该流短暂不实时，5s TTL 自然恢复）。
 */
export async function getFeedSalts(): Promise<FeedSalts> {
  try {
    const { getSession } = await import("./auth");
    const session = await getSession();
    if (!session) return { news: "", video: "" };
    const [news, video] = await Promise.all([getNewsWatermark(), getVideoWatermark()]);
    return { news: `n${news}`, video: `v${video}` };
  } catch {
    return { news: "", video: "" };
  }
}
