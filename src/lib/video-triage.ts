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
//   bit1 STNB 分位：beg>205 / int>160 / exp>150（flag 与 NF 同线，各级 p99 定标）；
//       2026-10-24 起两路豁免：初级 3BV<10 运气盘不判（与 3BV/s 划线同口径）、可信用户组不判
//   bit2 cls>10 次/秒（全站真实 max 7.77）
//   bit3 path=0 且 cl>20（无移动连点）——ppc 阈值暂不启用（回测 min 1.106 远离 0.5，无区分度）
//   bit4 点击数不足：cl < board_3bv × 0.8（cl 用 video_metrics.cl＝flop 重放口径，
//       与后台展示的「点击数」同源——2026-10-28 修复：原实现用 pressPairStats 数
//       事件流按下事件，速旗/连击的自动双击录独立 mr 事件（flop 计 Double++）但
//       pressPairStats 归入松开分支不计数，双击重度局被系统性少计误触发（生产
//       348011：3BV=20 flop cl=35，按下计数 15<16 误报）。metrics 缺行回退事件流计数）
//   bit5 （预留，原「首击延迟」信号已废——录像计时从首事件起算恒 0，无区分度）
//   bit6 破个人纪录（time / 3bvs 任一将刷新，需调用方传入，见 triageVideo 注释）
//   bit7 级别 TOP 榜（时间 TOP100 / 3bvs TOP10，同上由调用方判定传入）
//   bit8 首次入伍（三级成绩将首次齐全，同上）
//   bit9 低信任：上传者属低信任组（口径见 lib/lowtrust.ts：反作弊标记未到期 ∪ 屏蔽史）
//
// 另外的强制口径（不是触发器）：bit16 在线排行模式录像强制转手审
//   （2026-10-27 张老师指令开启，2026-10-28 张老师指令关闭——排名局走正常分拣；
//   开关 RANKED_FORCE_MANUAL_REVIEW，存量旧位重跑分拣即覆盖清除）
//
// 失败兜底：读文件/解析/计算任一失败 → auto_flag=2（按需核定），绝不静默免核定。
// 结果仅后台展示，玩家端任何页面不出现机器判定痕迹（张老师拍板④）。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "./db";
import { MIN_3BV_FOR_3BVS } from "./config";
import { parseVideoBinary } from "./videoradar";
import type { ParsedVideo } from "./rawvf";
import { AUTO_REASON, PRESS_AVG_MS, STNB_TRIGGER, PATH_SPEED_TRIGGER, PATH_SPEED_MIN_TIME_MS, BLIND_RATE_TRIGGER, BLIND_RATE_MIN_BLINDS, BLIND_RATE_MIN_CLICKS, RANKED_FORCE_MANUAL_REVIEW } from "./video-triage-limits";
import { RANKED_SOFTWARE } from "./evfwrite";
import { loadBlockedHistoryOf, lowTrustState } from "./lowtrust";
import { auditRankedGame } from "../core/src/lib/ranked-audit";

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

const EV_LINE = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;

export interface PressPairStats {
  leftAvg: number | null;
  leftN: number;
  rightAvg: number | null;
  rightN: number;
  cl: number;
}

/** 左键按下＝lc/mc/sc、松开＝lr/mr；右键按下＝rc、松开＝rr；时间序自然配对。
 *  ts 可为负（evf 负值修正：开局前按下）——按下/松开哨兵用 null，不能用 -1，
 *  否则负时间按下会被哨兵吞掉（按下时长统计丢对）。
 *  同刻配对（差 0ms）不计入时长：evf 时间量化到 10ms，人最快按不住 0ms，
 *  这类配对一律是合成事件——开局前状态压到 0 点、avfwrite 的 repairWinningEvents
 *  补洞（末尾同时间戳批量点击）。计进去会把真人按压均值拉向 0，误触 <45ms 门线
 *  （2026-10-27 347863 实测：含 5 次补洞时 59.4ms，剔除后真实 70ms）。 */
export function pressPairStats(v: ParsedVideo): PressPairStats {
  const presses: { L: number | null; R: number | null } = { L: null, R: null };
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
      if (presses.L !== null) {
        const d = ts - presses.L;
        if (d > 0) dursL.push(d);
        presses.L = null;
      }
    } else if (ev === "rr") {
      if (presses.R !== null) {
        const d = ts - presses.R;
        if (d > 0) dursR.push(d);
        presses.R = null;
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

/** 上传者信任信息（一次查询同时拿低信任与可信组两个口径）
 *  低信任口径 2026-10-27 收敛到 lib/lowtrust（后台组列表 / 详情页 / 分拣三处共用）：
 *  反作弊标记未到期 ∪ 屏蔽史（屏蔽时刻晚于人工移出时刻）；封禁账号不计入。 */
export async function getUserTrustInfo(userId: number): Promise<{ lowTrust: boolean; trusted: boolean }> {
  const [userRow, blocked] = await Promise.all([
    prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { trusted: true, lowTrustUntil: true, lowTrustExempt: true },
    }),
    loadBlockedHistoryOf(userId),
  ]);
  return { lowTrust: lowTrustState(userRow, blocked).member, trusted: Boolean(userRow?.trusted) };
}

/** 上传者是否低信任：名下有被屏蔽录像 / 账号曾被封 / 反作弊标记未到期（user.status=-1 即封禁口径，含限时未到期） */
export async function isLowTrustUser(userId: number): Promise<boolean> {
  return (await getUserTrustInfo(userId)).lowTrust;
}

// ---------- 判档主函数 ----------

export interface TriageResult {
  flag: 0 | 1 | 2;
  reason: number;
}

/**
 * 对已解析的录像跑触发器组（纯函数，不落库）。
 * stnb/cls/path/cl 来自 video_metrics（调用方读库传入；缺行＝按需核定保守处理）。
 * cl 为 flop 重放总点击（bit4 点击数下限的判定口径，与后台展示同源）。
 * timeMs 为库内权威用时（video_info.real_time，ms）——path 瞬移密度守卫需要。
 * trusted 为上传者是否在可信用户组（组内不检查 STNB 触发器，2026-10-24）。
 */
export function triageParsed(
  v: ParsedVideo,
  level: string,
  metrics: { stnb: number | null; cls: number | null; path: number | null; cl?: number | null } | null,
  lowTrust: boolean,
  extra: TriageExtra = {},
  timeMs: number = v.timeMs,
  trusted: boolean = false
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
    // STNB 触发器豁免（2026-10-24 张老师定）：
    // ① 初级 3BV<10 运气盘 STNB 无意义（与 3BV/s 划线口径 MIN_3BV_FOR_3BVS.beg=10 一致）；
    // ② 可信用户组不检查 STNB。bbbv 未知（解析缺值）时同按不检查处理——无盘面 3BV 的 STNB 本就无从谈起。
    const stnbBbbvValid = level !== "beg" || (v.bbbv !== null && v.bbbv >= MIN_3BV_FOR_3BVS.beg);
    if (!trusted && stnbBbbvValid && metrics.stnb !== null && metrics.stnb > (STNB_TRIGGER[level] ?? Infinity)) {
      reason |= AUTO_REASON.STNB;
    }
    if (metrics.cls !== null && metrics.cls > CLS_TRIGGER) reason |= AUTO_REASON.CLS;
    if (metrics.path !== null && metrics.path === 0 && ps.cl > 20) reason |= AUTO_REASON.PATH0;
  }
  // bit4 点击数下限：优先 flop 重放口径（video_metrics.cl，与后台展示同源，
  // 自动双击 mr 计 Double++ 在内）；metrics 缺行/未传 cl 时回退事件流按下计数。
  const cl = metrics?.cl ?? ps.cl;
  if (cl > 0 && v.bbbv !== null && v.bbbv > 0 && cl < v.bbbv * CLICK_FLOOR_RATIO) {
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
 * 排名局审计复算（2026-10-28）：上传时审计值只经 uploadExtra 透传、不落库，
 * 存量重分拣拿不到——从库内 evf 重新算（与上传链路 auditRankedGame 同引擎，
 * 事件还原口径同 core/scripts/audit-one-evf.ts：mr → sc+lr）。
 * 只对排名录像生效（software=Saolei.wang 或带 evf 签名）；其余返回 null 不判。
 */
function recomputeRankedAudit(
  software: string | null,
  evfSig: string | null,
  parsed: ParsedVideo
): { clicks: number; blindClicks: number } | null {
  if (software !== RANKED_SOFTWARE && !evfSig) return null;
  try {
    const width = parsed.width, height = parsed.height;
    const mines = new Uint8Array(width * height);
    for (let i = 0; i < mines.length; i++) mines[i] = parsed.board[i] === "*" ? 1 : 0;
    // RawVF 事件名 → Online/AVF 鼠标码（auditRankedGame 的编码）；mr（chord）
    // 还原为 sc+lr 对——与权威原始流在审计状态机下逐格等价（无旗副作用）
    const CODE: Record<string, number> = { mv: 1, lc: 3, lr: 5, rc: 9, rr: 17, sc: 11, mr: 65 };
    const events: { mouse: number; x: number; y: number }[] = [];
    for (const lineStr of parsed.events) {
      const m = EV_LINE.exec(lineStr);
      if (!m) continue;
      const code = CODE[m[2]];
      if (code === undefined) continue;
      const x = +m[5], y = +m[6];
      if (code === 65) {
        events.push({ mouse: 11, x, y });
        events.push({ mouse: 5, x, y });
      } else {
        events.push({ mouse: code, x, y });
      }
    }
    const stats = auditRankedGame(width, height, parsed.mines, mines, events, {
      nf: parsed.noflag,
      questionMarks: parsed.marks,
    });
    return stats ? { clicks: stats.clicks, blindClicks: stats.blindClicks } : null;
  } catch {
    return null;
  }
}

/** 排名上传专用的额外信号（调用方算好传入，普通上传不传） */
export interface TriageUploadExtra {
  /** 本局行为审计：决策点击数与盲区点击数（lib/ranked-audit.ts 重放权威事件流所得） */
  auditClicks?: number;
  auditBlindClicks?: number;
  /** 本次上传来自在线排行模式专用入口（2026-10-27）——与库内 software/evf_sig 双保险 */
  ranked?: boolean;
}

/**
 * 对一盘录像执行完整分拣并写回 auto_flag / auto_reason。
 * 供上传 after() 钩子与存量回填脚本共用。失败一律写 FAILED（按需核定），静默返回。
 */
export async function triageVideo(videoId: number, uploadExtra: TriageUploadExtra = {}): Promise<void> {
  try {
    const id = BigInt(videoId);
    const [video, info] = await Promise.all([
      prisma.video.findUnique({ where: { id }, select: { level: true, user: true, status: true } }),
      prisma.videoInfo.findUnique({ where: { id }, select: { filepath: true, board3bv: true, realTime: true, noflag: true, evfSig: true, software: true } }),
    ]);
    if (!video || !info) return;

    // 在线排行模式强制转手审识别（口径见 RANKED_FORCE_MANUAL_REVIEW，2026-10-28 起关闭）：
    // 上传入口显式标记 / 库内软件名 / 服务端签名三路兜底——存量回填与后台重分拣
    // 拿不到 uploadExtra 也能命中。开关关闭时 rankedHit 恒 false
    const rankedHit =
      RANKED_FORCE_MANUAL_REVIEW &&
      Boolean(uploadExtra.ranked || info.software === RANKED_SOFTWARE || info.evfSig !== null);
    const rankedReason = rankedHit ? AUTO_REASON.RANKED_MANUAL : 0;

    const buf = readVideoFile(info.filepath);
    if (!buf) {
      await prisma.video.update({ where: { id }, data: { autoFlag: AUTO_FLAG.FAILED, autoReason: rankedReason } });
      return;
    }
    const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
    const parsed = parseVideoBinary(buf, ext);
    if (!parsed) {
      await prisma.video.update({ where: { id }, data: { autoFlag: AUTO_FLAG.FAILED, autoReason: rankedReason } });
      return;
    }

    const metrics = await prisma.videoMetrics.findUnique({
      where: { id },
      select: { stnb: true, cls: true, path: true, cl: true },
    });

    const { lowTrust, trusted } = await getUserTrustInfo(Number(video.user));
    const { flag: baseFlag, reason: baseReason } = triageParsed(
      parsed,
      video.level,
      metrics,
      lowTrust,
      {},
      info.realTime,
      trusted
    );
    let flag = baseFlag;
    let reason = baseReason;

    // evf 校验（2026-10-24 引入，2026-10-28 张老师收窄口径）：ms-toollib is_valid
    // 只跑**元扫雷** evf（库白名单止于元3.3.4，元3.3.5+ 会误报 bit12；软件按
    // 「元」前缀识别，与后台软件筛选同口径）。本站客户端 evf 不走 ms-toollib——
    // 白名单外 verdict 恒 1 是预期而非作弊信号，排名/练习 evf 由下方 evf_sig
    // HMAC 验签自行把关。校验失败（null）无信号，不影响原判档。
    if (ext === "evf") {
      if (info.software?.startsWith("元")) {
        const { evfIsValid } = await import("./msvalid");
        const result = await evfIsValid(buf, path.basename(info.filepath));
        if (result?.verdict === 1) reason |= AUTO_REASON.MSTOOL_FAIL;
        else if (result?.verdict === 3) reason |= AUTO_REASON.MSTOOL_SUSPECT;
        flag = reason === 0 ? 1 : 0;
      }
      // 排名 evf 签名校验（2026-10-27 张老师要求）：库内 evf_sig 与文件字节 HMAC 比对。
      // invalid（不一致）= 文件被替换/篡改 → bit15 需核定；unsigned（无签名，历史/普通上传）不判
      if (info.evfSig) {
        const { verifyEvfSig } = await import("../core/src/lib/evf-sign");
        if (verifyEvfSig(buf, info.evfSig) === "invalid") {
          reason |= AUTO_REASON.EVF_SIG;
          flag = 0;
        }
      }
    }

    // 盲区率触发器（2026-10-27 张老师定标 2%）：排名局盲区点击率 <2% 且 STNB 超线才需核定。
    // 定标依据：高级时间榜 TOP20 真人实测全部 2.6%~10%，2% 线零误伤且仍兜住机器特征。
    // 双守卫（张老师补充）：整局盲区 <2 个比率无参考意义（初/中级短局天然盲区少，
    // 不应触发）；决策点击太少（<15）同样无统计意义。盲区 ≥2 且 <2% 蕴含点击 >100
    // STNB 联合门槛（2026-10-28 张老师收窄，348259 案）：新手往往全程不猜雷，
    // 慢速稳扎局盲区率低是正常行为——只有 STNB 值高（超同级触发线）且盲区率低
    // 才值得怀疑（快 + 从不盲 = 求解器特征）。STNB 缺行/未知不判本位。
    const audit = uploadExtra.auditClicks !== undefined && uploadExtra.auditBlindClicks !== undefined
      ? { clicks: uploadExtra.auditClicks, blindClicks: uploadExtra.auditBlindClicks }
      : recomputeRankedAudit(info.software, info.evfSig, parsed);
    if (audit &&
        audit.clicks >= BLIND_RATE_MIN_CLICKS &&
        audit.blindClicks >= BLIND_RATE_MIN_BLINDS &&
        audit.blindClicks / audit.clicks < BLIND_RATE_TRIGGER &&
        metrics?.stnb !== null && metrics?.stnb !== undefined &&
        metrics.stnb > (STNB_TRIGGER[video.level] ?? Infinity)) {
      reason |= AUTO_REASON.BLIND_RATE;
      flag = 0;
    }

    // 在线排行模式录像强制转手审（2026-10-27 开启，2026-10-28 张老师指令关闭：
    // 排名局走正常分拣逻辑）。开关再开 true 即恢复强制；关闭后 rankedHit 恒 false，
    // 重跑分拣会覆盖掉存量已打的 bit16（识别三路兜底见上方 rankedHit 注释）。
    if (rankedHit) {
      reason |= AUTO_REASON.RANKED_MANUAL;
      flag = 0;
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
