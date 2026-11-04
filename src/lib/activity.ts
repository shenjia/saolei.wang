// 排行榜活跃度标记（2026-11-04 张老师需求）：
// 人名性别标记后加一个「.」，按活跃度着色（多档命中取最高优先级）：
//   金   = 7 天内破过纪录（news type 20/21/22，含首创「创造了」行）
//   绿   = 7 天内传过录像（video status<>0，待审/过审都算「传过」）
//   白   = 7 天内登录过（user.last_login_time）
//   亮灰 = 7~30 天未登录
//   浅灰 = 30~60 天未登录
//   深灰 = 60 天以上未登录（last_login_time=0 未记录的也归此档）
// 同时产出 hover 气泡第二行文案（括号内，颜色与点一致）：
//   已XX天/xx月/xx年未登录；30天内登录过；7天内登录过；7天内传过录像；7天内破过纪录。
// 每榜页只对当页 20~100 行批量三查并行（video 走 (user,level) 索引、news 走 (user,create_time) 索引），
// 不缓存——act 必须随渲染时刻实时（若塞进 BV/STNB 的 1h 全量缓存会僵死 1 小时）。

import { prisma } from "./db";
import { NEWS_TYPE } from "./config";

const DAY = 86400;

/** 活跃度等级（渲染端只认数字，颜色类名 act_<level> 在 CSS 定义） */
export const ACT_DARK = 1; // 60 天以上未登录（深灰）
export const ACT_LIGHT = 2; // 30~60 天未登录（浅灰）
export const ACT_BRIGHT = 3; // 7~30 天未登录（亮灰）
export const ACT_WHITE = 4; // 7 天内登录过（白）
export const ACT_GREEN = 5; // 7 天内传过录像（绿）
export const ACT_GOLD = 6; // 7 天内破过纪录（金）

export interface ActivityInfo {
  /** 活跃度等级（1~6，见上） */
  act: number;
  /** 气泡第二行文案（不含括号；颜色与 act 对应） */
  tip: string;
}

/** 未登录时长文案：XX天（<60d）/ xx月（<1年）/ xx年（≥1年） */
function awayText(lastLogin: number, now: number): string {
  if (lastLogin <= 0) return "60天以上未登录"; // last_login_time=0 未记录，按档位口径表述
  const days = Math.floor((now - lastLogin) / DAY);
  if (days < 60) return `已${Math.max(days, 1)}天未登录`;
  if (days < 365) return `已${Math.floor(days / 30)}月未登录`;
  return `已${Math.floor(days / 365)}年未登录`;
}

/**
 * 批量计算活跃度。返回 Map<uid, ActivityInfo>；查无此用户的 id 不入 Map
 * （渲染端 act 缺省时不渲染点与气泡行）。
 */
export async function activityInfo(ids: number[]): Promise<Map<number, ActivityInfo>> {
  const out = new Map<number, ActivityInfo>();
  const uniq = [...new Set(ids)].filter((v) => Number.isFinite(v) && v > 0);
  if (!uniq.length) return out;
  const now = Math.floor(Date.now() / 1000);
  const w7 = now - 7 * DAY;
  const placeholders = uniq.map(() => "?").join(",");
  const idArgs = uniq.map((v) => BigInt(v));
  const [users, uploads, records] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: idArgs } },
      select: { id: true, lastLoginTime: true },
    }),
    // 传过录像：status<>0（待审 10 / 过审 20 都算「传过」，屏蔽 0 不算）
    prisma.$queryRawUnsafe<{ user: bigint }[]>(
      `SELECT DISTINCT user FROM video WHERE user IN (${placeholders}) AND status <> 0 AND create_time >= ?`,
      ...idArgs,
      BigInt(w7)
    ),
    // 破过纪录：纪录动态三类型（个人 20 / 地区 21 / 全国 22）
    prisma.$queryRawUnsafe<{ user: bigint }[]>(
      `SELECT DISTINCT user FROM news WHERE user IN (${placeholders})
       AND type IN (${NEWS_TYPE.PERSON_RECORD},${NEWS_TYPE.AREA_RECORD},${NEWS_TYPE.NATION_RECORD})
       AND create_time >= ?`,
      ...idArgs,
      BigInt(w7)
    ),
  ]);
  const login = new Map(users.map((u) => [Number(u.id), Number(u.lastLoginTime ?? 0)]));
  const uploaded = new Set(uploads.map((r) => Number(r.user)));
  const broke = new Set(records.map((r) => Number(r.user)));
  for (const id of uniq) {
    const last = login.get(id) ?? 0;
    let info: ActivityInfo;
    if (broke.has(id)) info = { act: ACT_GOLD, tip: "7天内破过纪录" };
    else if (uploaded.has(id)) info = { act: ACT_GREEN, tip: "7天内传过录像" };
    else if (last >= w7) info = { act: ACT_WHITE, tip: "7天内登录过" };
    else if (last >= now - 30 * DAY) info = { act: ACT_BRIGHT, tip: "30天内登录过" };
    else if (last >= now - 60 * DAY) info = { act: ACT_LIGHT, tip: awayText(last, now) };
    else info = { act: ACT_DARK, tip: awayText(last, now) };
    out.set(id, info);
  }
  return out;
}
