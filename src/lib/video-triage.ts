// 录像自动分拣（2026-10-19 方案 v2，张老师拍板：机器只分拣、不审批）
//
// 职责：对一盘刚落库的待审录像跑触发器组，产出「免核定 / 需核定 + 原因位码」，
//      写回 video.auto_flag / auto_reason。**永不触碰 video.status**——通过/屏蔽
//      永远由管理员手动执行（免核定池批量一键过、需核定逐条手审）。
//
// 触发器（任一命中 → 需核定）：
//   bit0 press-release：全盘左键按下→松开平均 ≤ 阈值ms（beg 45 / int 45 / exp 60；
//       2026-10-19 张老师晚定中级放宽 56→45，初/中同线；高级沿用 60），
//       守卫配对数 n≥30；左右键独立判（各自 n≥30 且 ≤阈值）。分级依据：初级人类
//       普遍点击快（p50 仅 72ms），统一 60ms 线会误落 17% 真人（回测 9837 盘实证）
//   bit1 STNB 分位：beg>205 / int>160 / exp>150（flag 与 NF 同线，各级 p99 定标）
//   bit2 cls>10 次/秒（全站真实 max 7.77）
//   bit3 path=0 且 cl>20（无移动连点）——ppc 阈值暂不启用（回测 min 1.106 远离 0.5，无区分度）
//   bit4 点击数不足：cl < board_3bv × 0.8
//   bit5 （预留，原「首击延迟」信号已废——录像计时从首事件起算恒 0，无区分度）
//   bit6 破个人纪录（time / 3bvs 任一将刷新，需调用方传入，见 triageVideo 注释）
//   bit7 级别 TOP 榜（时间 TOP100 / 3bvs TOP10，同上由调用方判定传入）
//   bit8 首次入伍（三级成绩将首次齐全，同上）
//   bit9 低信任：上传者名下有被屏蔽录像 或 账号曾被封
//
// 失败兜底：读文件/解析/计算任一失败 → auto_flag=2（按需核定），绝不静默免核定。
// 结果仅后台展示，玩家端任何页面不出现机器判定痕迹（张老师拍板④）。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "./db";
import { parseVideoBinary } from "./videoradar";
import type { ParsedVideo } from "./rawvf";
import { AUTO_REASON, PRESS_AVG_MS, STNB_TRIGGER, PATH_SPEED_TRIGGER, PATH_SPEED_MIN_TIME_MS } from "./video-triage-limits";

export { AUTO_REASON, PRESS_AVG_MS, STNB_TRIGGER };

/** 配对数守卫：低于此数不判 press（初级短局 2~21 次配对噪声大） */
const PRESS_MIN_PAIRS = 30;
/** cls 手速阈值（次/秒，全站真实 max 7.77） */
const CLS_TRIGGER = 10;
/** 点击数下限系数：cl < bbbv × 该系数 → 命中 */
const CLICK_FLOOR_RATIO = 0.8;

/** auto_flag 取值 */
export const AUTO_FLAG = {
  NEED_REVIEW: 0, // 需核定（任一触发器命中 / 低信任）——只能逐条手审
  EXEMPT: 1,      // 免核定（零命中）——可批量一键通过
  FAILED: 2,      // 分拣失败（读文件/解析失败）——按需核定兜底
  UNSET: -1,      // 未分拣（历史存量未回填）——视同需核定保守处理
} as const;

// ---------- path 瞬移异常统计（2026-10-23；347022 与已屏蔽 3 盘同款作弊形态） ----------
//
// 形态：相邻事件 >JUMP_PX 像素的「超大范围瞬移」贡献了全盘大部分行程，且瞬移方向
// 左右对称（跳出去→马上跳回来），呈周期性（嫌疑盘 2~5 次/秒）。正常人类盘（含
// ppc 高到 300+ 的慢局）瞬移占比 ≤34% 且无对称往返；慢局思考期偶发大跳（81983
// 实证：987s 内 34 跳=0.03 次/秒）由密度守卫排除。全站 30 万盘回扫零误报。

/** 瞬移判定：相邻事件位移超过此像素数 */
const JUMP_PX = 100;
/** 异常判定：瞬移贡献行程占比超过此比例 */
const JUMP_RATIO_TRIGGER = 0.5;
/** 守卫：总行程低于此格数不判（分母太小，短局偶发瞬移会虚高占比） */
const MIN_PATH_CELLS = 200;
/** rmv 哨兵坐标（Vienna 格式越界哨兵 ~65523，259991/274037 实证）——断链不计位移 */
const SENTINEL_PX = 60000;
/** 守卫：瞬移密度低于此次/秒不判（人类慢局思考期偶发大跳） */
const MIN_JUMPS_PER_SEC = 0.5;
/** 守卫：瞬移次数下限 */
const MIN_JUMPS = 10;

export interface PathJumpStats {
  /** 瞬移贡献行程占比（0~1），未达标守卫时为 null */
  jumpRatio: number | null;
  jumpCount: number;
  /** 哨兵过滤后的总行程（格）——PATH_SPEED 触发器复用，与 metrics path 口径一致 */
  totalCells: number;
}

/** 对事件行流算瞬移统计（纯函数；timeMs 由调用方传入） */
export function pathJumpStats(v: ParsedVideo, timeMs: number): PathJumpStats {
  let totalPx = 0, jumpsPx = 0, jumpCount = 0;
  let lastPx: number | null = null, lastPy: number | null = null;
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const px = +m[5], py = +m[6];
    if (px >= SENTINEL_PX || py >= SENTINEL_PX || px < 0 || py < 0) {
      lastPx = null; lastPy = null; // 哨兵：断开位移链
      continue;
    }
    if (lastPx !== null && lastPy !== null) {
      const d = Math.hypot(px - lastPx, py - lastPy);
      totalPx += d;
      if (d > JUMP_PX) { jumpsPx += d; jumpCount++; }
    }
    lastPx = px; lastPy = py;
  }
  const totalCells = Math.round(totalPx / 16);
  if (totalPx < MIN_PATH_CELLS * 16) return { jumpRatio: null, jumpCount, totalCells };
  const durSec = timeMs / 1000;
  if (jumpCount < MIN_JUMPS || (durSec > 0 && jumpCount / durSec < MIN_JUMPS_PER_SEC)) {
    return { jumpRatio: null, jumpCount, totalCells };
  }
  return { jumpRatio: jumpsPx / totalPx, jumpCount, totalCells };
}

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

// ---------- press-release 统计（与回测脚本同一口径） ----------

const EV_LINE = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;

export interface PressPairStats {
  leftAvg: number | null;
  leftN: number;
  rightAvg: number | null;
  rightN: number;
  cl: number;
}

/** 左键按下＝lc/mc/sc、松开＝lr/mr；右键按下＝rc、松开＝rr；时间序自然配对 */
export function pressPairStats(v: ParsedVideo): PressPairStats {
  const presses: { L: number; R: number } = { L: -1, R: -1 };
  const dursL: number[] = [];
  const dursR: number[] = [];
  let cl = 0;
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const ts = parseFloat(m[1]) * 1000;
    const ev = m[2];
    if (ev === "lc" || ev === "mc" || ev === "sc") {
      presses.L = ts;
      cl++;
    } else if (ev === "rc") {
      presses.R = ts;
      cl++;
    } else if (ev === "lr" || ev === "mr") {
      if (presses.L >= 0) {
        dursL.push(ts - presses.L);
        presses.L = -1;
      }
    } else if (ev === "rr") {
      if (presses.R >= 0) {
        dursR.push(ts - presses.R);
        presses.R = -1;
      }
    }
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { leftAvg: avg(dursL), leftN: dursL.length, rightAvg: avg(dursR), rightN: dursR.length, cl };
}

// ---------- 榜单/纪录/入伍判定输入（bit6/7/8 由调用方算好传入，保持本模块纯函数） ----------

export interface TriageExtra {
  /** 该盘将刷新上传者任一级别 time/3bvs 最好成绩（bit6） */
  personRecord?: boolean;
  /** 该盘成绩将进级别 TOP 榜（时间 TOP100 / 3bvs TOP10，bit7） */
  topBoard?: boolean;
  /** 该盘通过将使上传者三级成绩首次齐全（触发入伍动态，bit8） */
  firstEnlist?: boolean;
}

/** 上传者是否低信任：名下有被屏蔽录像 或 账号曾被封（user.status=-1 即封禁口径，含限时未到期） */
export async function isLowTrustUser(userId: number): Promise<boolean> {
  const [bannedVideo, userRow] = await Promise.all([
    prisma.video.findFirst({ where: { user: BigInt(userId), status: 0 }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: BigInt(userId) }, select: { status: true } }),
  ]);
  if (bannedVideo) return true;
  if (userRow && userRow.status === -1) return true;
  return false;
}

// ---------- 判档主函数 ----------

export interface TriageResult {
  flag: 0 | 1 | 2;
  reason: number;
}

/**
 * 对已解析的录像跑触发器组（纯函数，不落库）。
 * stnb/cls/path 来自 video_metrics（调用方读库传入；缺行＝按需核定保守处理）。
 * timeMs 为库内权威用时（video_info.real_time，ms）——path 瞬移密度守卫需要。
 */
export function triageParsed(
  v: ParsedVideo,
  level: string,
  metrics: { stnb: number | null; cls: number | null; path: number | null } | null,
  lowTrust: boolean,
  extra: TriageExtra = {},
  timeMs: number = v.timeMs
): TriageResult {
  let reason = 0;

  const ps = pressPairStats(v);
  const pressMs = PRESS_AVG_MS[level] ?? 60;
  if ((ps.leftAvg !== null && ps.leftN >= PRESS_MIN_PAIRS && ps.leftAvg <= pressMs) ||
      (ps.rightAvg !== null && ps.rightN >= PRESS_MIN_PAIRS && ps.rightAvg <= pressMs)) {
    reason |= AUTO_REASON.PRESS;
  }

  // path 瞬移异常（2026-10-23；timeMs 用库内权威值，调用方在 triageVideo 传入）
  const pj = pathJumpStats(v, timeMs);
  if (pj.jumpRatio !== null && pj.jumpRatio > JUMP_RATIO_TRIGGER) {
    reason |= AUTO_REASON.PATH_JUMP;
  }

  // path 超速（2026-10-23）：≥30s 盘全程平均移动速率超 30 格/s。
  // 定标：人类全站（含 Vienna 高采样盘）≥30s max=22.4 格/s；347022 作弊盘 51.2。
  // 短局不判（5.5s 初级局人类可瞬时甩出 54.9 格/s）。
  if (timeMs >= PATH_SPEED_MIN_TIME_MS) {
    const cellsPerSec = pj.totalCells / (timeMs / 1000);
    if (cellsPerSec > PATH_SPEED_TRIGGER) reason |= AUTO_REASON.PATH_SPEED;
  }

  if (metrics) {
    if (metrics.stnb !== null && metrics.stnb > (STNB_TRIGGER[level] ?? Infinity)) reason |= AUTO_REASON.STNB;
    if (metrics.cls !== null && metrics.cls > CLS_TRIGGER) reason |= AUTO_REASON.CLS;
    if (metrics.path !== null && metrics.path === 0 && ps.cl > 20) reason |= AUTO_REASON.PATH0;
  }
  if (ps.cl > 0 && v.bbbv !== null && v.bbbv > 0 && ps.cl < v.bbbv * CLICK_FLOOR_RATIO) {
    reason |= AUTO_REASON.CLICK_FLOOR;
  }

  if (extra.personRecord) reason |= AUTO_REASON.PERSON_RECORD;
  if (extra.topBoard) reason |= AUTO_REASON.TOP_BOARD;
  if (extra.firstEnlist) reason |= AUTO_REASON.FIRST_ENLIST;
  if (lowTrust) reason |= AUTO_REASON.LOW_TRUST;

  return { flag: reason === 0 ? 1 : 0, reason };
}

/** video_info.filepath 形如 /2026/01/05/xxx.mvf（带前导斜杠，相对 videos 根） */
function readVideoFile(filepath: string): Uint8Array | null {
  try {
    const full = path.resolve(VIDEOS_ROOT, "." + filepath);
    if (!full.startsWith(VIDEOS_ROOT + path.sep)) return null;
    return new Uint8Array(readFileSync(full));
  } catch {
    return null;
  }
}

/**
 * 对一盘录像执行完整分拣并写回 auto_flag / auto_reason。
 * 供上传 after() 钩子与存量回填脚本共用。失败一律写 FAILED（按需核定），静默返回。
 */
export async function triageVideo(videoId: number): Promise<void> {
  try {
    const id = BigInt(videoId);
    const [video, info] = await Promise.all([
      prisma.video.findUnique({ where: { id }, select: { level: true, user: true, status: true } }),
      prisma.videoInfo.findUnique({ where: { id }, select: { filepath: true, board3bv: true, realTime: true, noflag: true } }),
    ]);
    if (!video || !info) return;

    const buf = readVideoFile(info.filepath);
    if (!buf) {
      await prisma.video.update({ where: { id }, data: { autoFlag: AUTO_FLAG.FAILED, autoReason: 0 } });
      return;
    }
    const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
    const parsed = parseVideoBinary(buf, ext);
    if (!parsed) {
      await prisma.video.update({ where: { id }, data: { autoFlag: AUTO_FLAG.FAILED, autoReason: 0 } });
      return;
    }

    const metrics = await prisma.videoMetrics.findUnique({
      where: { id },
      select: { stnb: true, cls: true, path: true },
    });

    const lowTrust = await isLowTrustUser(Number(video.user));
    const { flag: baseFlag, reason: baseReason } = triageParsed(parsed, video.level, metrics, lowTrust, {}, info.realTime);
    let flag = baseFlag;
    let reason = baseReason;

    // evf 附加校验（2026-10-24）：ms-toollib is_valid（软件白名单/校验和/公平性/
    // 完成性/鼠标轨迹特征）→ bit12 不通过 / bit13 可疑。只作分拣信号、不上传硬拒
    // （库白名单止于元3.3.4，元 3.3.5+ 新版本真录像会误报不通过——见 lib/msvalid.ts）。
    // 校验失败（null）无信号，不影响原判档。
    if (ext === "evf") {
      const { evfIsValid } = await import("./msvalid");
      const result = await evfIsValid(buf, path.basename(info.filepath));
      if (result?.verdict === 1) reason |= AUTO_REASON.MSTOOL_FAIL;
      else if (result?.verdict === 3) reason |= AUTO_REASON.MSTOOL_SUSPECT;
      flag = reason === 0 ? 1 : 0;
    }

    await prisma.video.update({ where: { id }, data: { autoFlag: flag, autoReason: reason } });
  } catch {
    // 后置链路失败放行（对齐 videometrics.ts 容错原则）：尽力写 FAILED，写不进也不抛
    try {
      await prisma.video.update({
        where: { id: BigInt(videoId) },
        data: { autoFlag: AUTO_FLAG.FAILED, autoReason: 0 },
      });
    } catch {
      /* swallow */
    }
  }
}
