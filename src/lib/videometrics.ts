// 录像指标落库 —— 「video_metrics」的唯一写入口
//
// 三处调用者，共用同一份口径：
//   ① lib/review.ts 审核通过后 after() 自动补算（在线新录像）
//   ② video/[id] 详情页缺行兜底（历史遗留、跑批没覆盖到的）
//   ③ scripts/video-metrics.ts 跑批（全量 / 增量）
//
// 为什么是「幂等补缺」而不是「每次重算」：
//   录像文件一旦入库就不再变化，重放结果是确定性纯函数——同一盘永远算出同一个值，
//   没必要反复算；也正因为如此可以放心地只在首次缺行时补一次。
//   例外：引擎修 bug（如 2026-10-14 的「按下/松开」口径）后必须全量重跑，
//   那个语义在跑批脚本里（upsert 覆盖），与本模块的补缺语义刻意区分。
//
// 容错原则（对齐 CLAUDE.md「后置链路失败一律放行」）：这里任何失败都必须静默吞掉。
//   尤其是①挂在审核请求的后置钩子上，绝不能因为文件缺失/解析失败让审核返回失败。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "./db";
import { analyzeVideo, parseVideoBinary } from "./videoradar";
import { VIDEO_STATUS } from "./config";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

/** video_info.filepath 形如 /2007/01/05/xxx.mvf（相对 videos 根，带前导斜杠） */
function readVideoFile(filepath: string): Uint8Array | null {
  try {
    const full = path.resolve(VIDEOS_ROOT, "." + filepath);
    // 路径穿越防护：解析后必须仍在 videos 目录内
    if (!full.startsWith(VIDEOS_ROOT + path.sep)) return null;
    return new Uint8Array(readFileSync(full));
  } catch {
    return null;
  }
}

// 串行队列：后台「批量审核」会在一个请求里逐条调用 reviewVideo，
// 每条都注册一个 after 任务；不串行的话上百个大文件会被并发读入内存。
// 单盘重放实测约 2.4ms，几百条排队也就一秒级。
let tail: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}

async function compute(videoId: number): Promise<void> {
  const id = BigInt(videoId);

  const exist = await prisma.videoMetrics.findUnique({ where: { id }, select: { id: true } });
  if (exist) return;

  const [video, info] = await Promise.all([
    prisma.video.findUnique({ where: { id }, select: { status: true, level: true } }),
    prisma.videoInfo.findUnique({
      where: { id },
      select: { filepath: true, noflag: true, board3bv: true, realTime: true },
    }),
  ]);
  // 六维口径建立在「胜局」前提上：被屏蔽的录像算了也没意义。
  // 待审（status=10）10-16 起允许落行——详情页雷达对非屏蔽录像开放（张老师定）。
  // ⚠️ 基准防污染：本模块只写行不改行，待审行由跑批口径排除在基准外（跑批 dist
  //    只收 status=20 已通过 + cl>0 的行，见 scripts/video-metrics.ts），不会污染分位。
  if (!video || !info || video.status === VIDEO_STATUS.BANNED) return;

  const buf = readVideoFile(info.filepath);
  if (!buf) return;
  const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
  const m = analyzeVideo(buf, ext, {
    level: video.level,
    noflag: info.noflag,
    bbbvFallback: info.board3bv,
    // 用时与 3BV 一律以库为准 —— 见 analyzeVideo 注释（文件内 Time 在早期 mvf 上不可信）
    timeMs: info.realTime,
    bbbv: info.board3bv,
  });
  if (!m) return;

  const data = {
    level: m.level,
    noflag: m.noflag,
    realTime: info.realTime,
    bbbv: m.bbbv,
    cl: m.cl,
    clLeft: m.clLeft,
    clRight: m.clRight,
    clDouble: m.clDouble,
    ce: m.ce,
    unflag: m.unflag,
    path: m.path,
    bvs: m.bvs,
    ioe: m.ioe,
    corr: m.corr,
    cls: m.cls,
    ppc: m.ppc,
    stnb: m.stnb,
  };
  await prisma.videoMetrics.upsert({
    where: { id },
    create: { id, ...data, createTime: BigInt(Math.floor(Date.now() / 1000)) },
    update: data,
  });
}

/**
 * 确保该录像的指标行存在（缺则补、有则跳过）。
 * 供审核后置钩子与详情页兜底调用；失败一律静默，调用方无需感知。
 */
export function ensureVideoMetrics(videoId: number): Promise<void> {
  return serialize(() =>
    compute(videoId).catch(() => {
      /* 后置链路失败放行：缺一行最多是该盘没有雷达图，不影响任何主流程 */
    })
  );
}

/**
 * 确保该录像的棋盘串（video_info.board）存在——空则从文件现解析并回写。
 * 背景：RMV 上传时期站内无解析器，board 落库为空串（地图不显示）；
 * rmv.ts 上线后可现解析。详情页调用；解析不出/失败返回 null（棋盘留空，页面不 500）。
 */
export async function ensureVideoBoard(videoId: number): Promise<string | null> {
  try {
    const info = await prisma.videoInfo.findUnique({
      where: { id: BigInt(videoId) },
      select: { filepath: true, board: true },
    });
    if (!info || (info.board !== null && info.board !== "")) return info?.board ?? null;
    const buf = readVideoFile(info.filepath);
    if (!buf) return null;
    const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(buf, ext);
    if (!v || !v.board || v.board.length !== v.width * v.height) return null;
    await prisma.videoInfo.update({
      where: { id: BigInt(videoId) },
      data: { board: v.board },
    });
    return v.board;
  } catch {
    return null;
  }
}
