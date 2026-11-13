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
//   bit4 点击数低于 ZiNi 下界：cl < zini（2026-10-31 张老师提议，cl 用 video_metrics.cl
//       ＝flop 重放口径与后台「点击数」同源；zini 由 lib/zini.ts calZini 按盘面现算＝
//       已知雷位贪心最优解的最少点击估计，左/右/chord 各计 1——人类不可能比它更少，
//       低于即事件流被剪辑或盘面被篡改，物理不可能。替代旧口径 cl<0.8×3BV：旧线是
//       统计近似，天然低 zini 盘（高 chord 效率）被误伤（349311：3BV=25 zini=16 cl=18
//       正常局被标记）；全站 1200 盘过审抽检 cl<zini 零命中、历史 bit4 命中 801 盘中
//       740 盘在新口径下自动解除。盘面缺失（board 解析不出）回退旧 0.8×3BV 规则兜底）
//   bit5 （预留，原「首击延迟」信号已废——录像计时从首事件起算恒 0，无区分度）
//   bit6 破个人纪录（time / 3bvs 任一将刷新，需调用方传入，见 triageVideo 注释）
//   bit7 级别 TOP 榜（时间 TOP100 / 3bvs TOP10，同上由调用方判定传入）
//   bit8 首次入伍（三级成绩将首次齐全，同上）
//   bit9 低信任：上传者属低信任组（口径见 lib/lowtrust.ts：反作弊标记未到期 ∪ 屏蔽史）
//   bit17 PATH_SPARSE 轨迹稀疏：mv/点击比 <2.0 且全程无 ≥3 连密集采样串（桌面
//       软件人类 min 2.68；慢速真人低比值盘必有密集串；合成流≈1 且串长 1；
//       站内客户端与老 Clone 豁免——其 mv/点击比合法低至 1.56 / 1.7）
//   bit18 PATH_DT 轨迹无密集采样：相邻 mv 间隔全程 >100ms（任何真实鼠标移动都有
//       <16ms 的连续采样对；红客 360671 全程最密 450ms）
//   bit19 PRESS_UNIFORM 按压时长恒定：完全相同按压时长的众数占比 ≥ 初95%/中85%/
//       高75%（2026-11-13 张老师定改占比口径，替代旧 σ<8ms 线——Arbiter 10ms
//       量化下按压偏快的速通真人 σ 可到 5~8ms 被误伤；触控板流全部 <12ms 豁免）
//   bit20 CLICK_OFFSET 点击落点量化：格内偏移取值 <8 种或标准差 <1.6px（人类
//       min 11 种 / 2.54px；合成流 3 种 / 0.8px；站内客户端与老 Clone 豁免——
//       两格式落点=格中心是写流格式行为）
//   bit21 ZERO_PRESS 孤立同刻按压占比：按下与松开同刻、该时刻无其他点击事件、
//       且前后 250ms 内无其他点击（双击/快速连击豁免，2026-11-13 张老师定——
//       真人触控板快速点按/双击在量化下成零时长对；360671 节拍 470ms 不受影响）
//       占比 >30%（真人孤立
//       观测上限 15.5%；合成流 61%；clicks≥100 守卫；老 Clone 豁免——其瞬时
//       点击即同刻写 lc+lr）
//   bit22 GAP_MODE 长间隔精确节拍：空闲间隔（松开→下一次按下）众数 ≥180ms 且
//       精确占比 >23%（真人长间隔区极值 16.2%；360420=30.9%、347805=23.2%）
//       ——360420 型生成器补齐了 bit17~21 全部结构特征，但定时器节拍无法
//       伪装：真人高占比聚集全部在快速节奏区（众数 30~150ms）
//   bit23 SHORT_PRESS 短局超快按压（2026-11-13 沈正刚 28122 案）：press 配对
//       n≥10（放宽自 bit0 的 30 守卫）且平均 ≤30ms——3.6~5.7s 短局（16~24 次
//       点击）被所有 n≥30 守卫拦成零命中，唯一超人类信号 press avg 13~26ms
//       由此生效（人类初级 p1=44.3ms / p5≈50ms 留 14ms+ 余量）
//   bit24 ACCOUNT_PRESS 账号按压聚合（2026-11-13）：最近 30 盘中 press 可统计
//       （n≥15）盘 ≥3 且代表按压时长中位数 ≤40ms——单盘可擦线伪装，账号级
//       连续超人类难伪装；合成流批量上传（28122 当日 22 盘）账号层证据更早
//   （bit17~21 为 2026-11-12 人类相似度触发器组（红客 360671 案），定标与豁免
//       口径见 video-triage-limits.ts 头部注释及 humanLikeTriggers；
//       bit22 为同日点击节拍组（钮志锋 360420/347805 案）；曾试过 bit23
//       50ms 窗口带聚集层，全站回扫证伪删除——稳节奏真人窗口占比可达 61%）
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
import { calZini } from "./zini";
import { AUTO_REASON, PRESS_AVG_MS, STNB_TRIGGER, PATH_SPEED_TRIGGER, PATH_SPEED_MIN_TIME_MS, BLIND_RATE_TRIGGER, BLIND_RATE_MIN_BLINDS, BLIND_RATE_MIN_CLICKS, RANKED_FORCE_MANUAL_REVIEW, MV_PER_CLICK_TRIGGER, MV_MIN_DT_TRIGGER_MS, MIN_MV_BURST, PRESS_UNIFORM_SHARE, TOUCHPAD_MAX_PRESS_MS, DOUBLE_CLICK_WINDOW_MS, CLICK_OFFSET_DISTINCT_TRIGGER, CLICK_OFFSET_STD_TRIGGER, ZERO_PRESS_FRACTION_TRIGGER, TRAJ_MIN_CLICKS, TRAJ_MIN_MV, ZERO_PRESS_MIN_CLICKS, GAP_MODE_MIN_MS, GAP_MODE_SHARE_TRIGGER, GAP_MODE_MIN_COUNT, GAP_CADENCE_MIN_N, PRESS_SHORT_TRIGGER_MS, PRESS_SHORT_MIN_PAIRS, CLIENT_MV_PER_CLICK_LEGAL_MIN, CLONE_MV_PER_CLICK_LEGAL_MIN, ACCOUNT_PRESS_SCAN_LIMIT, ACCOUNT_PRESS_MIN_VIDEOS, ACCOUNT_PRESS_MEDIAN_MS } from "./video-triage-limits";
import { RANKED_SOFTWARE } from "./evfwrite";
import { loadBlockedHistoryOf, lowTrustState } from "./lowtrust";
import { auditRankedGame } from "../core/src/lib/ranked-audit";

export { AUTO_REASON, PRESS_AVG_MS, STNB_TRIGGER };

/** 配对数守卫：低于此数不判 press（初级短局 2~21 次配对噪声大） */
const PRESS_MIN_PAIRS = 30;
/** cls 手速阈值（次/秒，全站真实 max 7.77） */
const CLS_TRIGGER = 10;
/** 点击数下限系数（board 缺失回退口径）：cl < bbbv × 该系数 → 命中 */
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

/** 对事件行流算瞬移统计（纯函数；timeMs 由调用方传入）。
 *  哨兵断链两路：①rmv 越界哨兵（≥SENTINEL_PX）②EVF 排名局 heal/resume 合成
 *  事件的哨兵点 (W×16, H×16)——恰好落在 60000 线以内会被当真实坐标，每个哨兵
 *  制造出+回 2 次 >100px 假瞬移推高占比（2026-11-10 张一零 355576/355579/355591/
 *  355599 四盘 bit10 误报实证，哨兵 20~36 个/盘、断链后 jumpCount 全归零）。
 *  口径对齐 ms-toollib base_video.rs（行程锚定最后盘内位置）与 replay-core。 */
export function pathJumpStats(v: ParsedVideo, timeMs: number): PathJumpStats {
  const evfSentX = v.width * 16, evfSentY = v.height * 16;
  let totalPx = 0, jumpsPx = 0, jumpCount = 0;
  let lastPx: number | null = null, lastPy: number | null = null;
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const px = +m[5], py = +m[6];
    if (px >= SENTINEL_PX || py >= SENTINEL_PX || px < 0 || py < 0 ||
        (px === evfSentX && py === evfSentY)) {
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
  /** 左右键合并的最大配对时长 ms（无配对=null） */
  pressMaxMs: number | null;
  /** 左右键合并的配对时长中位数 ms（无配对=null）——触控板豁免判据（<12ms） */
  pressMedianMs: number | null;
}

/** 触控板豁免（2026-11-13 张老师定，v4 改中位数判据）：按压配对时长中位数
 *  <12ms → 触控板操作，按压类触发器（bit0/bit19/bit23）全部放过。v3 的
 *  「全部配对 <12ms」（max 判据）被偶发实体键长按/量化 20ms 离群击穿，大量
 *  误伤（生产探针：触控板真人中位数恒 10ms、生成器 8 盘 ≥12ms，见 limits 注释）。 */
export function isTouchpadPress(ps: PressPairStats): boolean {
  return ps.pressMedianMs !== null && ps.pressMedianMs < TOUCHPAD_MAX_PRESS_MS;
}

/** bit0（分级线，n≥30）+ bit23 短局超快按压（n≥10 且 ≤30ms）——左右键各自独立判，
 *  任一键命中即置位。触控板流（全部配对 <12ms）整组放过。
 *  triageParsed 与存量补判脚本共用同一口径，防两处漂移。 */
export function pressTriggers(ps: PressPairStats, level: string): number {
  if (isTouchpadPress(ps)) return 0;
  let bits = 0;
  const pressMs = PRESS_AVG_MS[level] ?? 50;
  const hit = (avg: number | null, n: number, line: number, minN: number) =>
    avg !== null && n >= minN && avg <= line;
  if (hit(ps.leftAvg, ps.leftN, pressMs, PRESS_MIN_PAIRS) ||
      hit(ps.rightAvg, ps.rightN, pressMs, PRESS_MIN_PAIRS)) {
    bits |= AUTO_REASON.PRESS;
  }
  if (hit(ps.leftAvg, ps.leftN, PRESS_SHORT_TRIGGER_MS, PRESS_SHORT_MIN_PAIRS) ||
      hit(ps.rightAvg, ps.rightN, PRESS_SHORT_TRIGGER_MS, PRESS_SHORT_MIN_PAIRS)) {
    bits |= AUTO_REASON.SHORT_PRESS;
  }
  return bits;
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
  const allDurs = [...dursL, ...dursR];
  const median = (a: number[]) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  return {
    leftAvg: avg(dursL), leftN: dursL.length,
    rightAvg: avg(dursR), rightN: dursR.length,
    cl,
    pressMaxMs: allDurs.length ? Math.max(...allDurs) : null,
    pressMedianMs: median(allDurs),
  };
}

// ---------- 人类相似度统计（2026-11-12 红客合成录像 360671 案；定标见 limits 注释） ----------
//
// 五路特征全部是「事件流结构」信号，与成绩指标（STNB/手速）正交，专门抓
// 生成器写流：真人移动有连续采样、按压时长有方差、落点有亚像素散布、
// 按压不可能零时长。人类基线（本地 938 + 生产 1418 分层抽样）与触发线 ≥2 倍分离。

export interface HumanLikeStats {
  /** 点击总数（lc/rc/mc/sc） */
  clicks: number;
  /** mv 事件总数 */
  mv: number;
  /** mv/点击比（clicks>0 时） */
  mvPerClick: number | null;
  /** 相邻 mv 最小间隔（ms；mv≥2 时） */
  mvMinDt: number | null;
  /** 最长密集采样串：连续 mv 且相邻间隔 ≤100ms 的最大连长（真鼠标移动必现 ≥3 连；
   *  合成流单步瞬移为 1；防「补一对假事件绕过 mvMinDt」） */
  maxMvBurst: number;
  /** 配对按压时长（d>0）样本数 */
  pressN: number;
  /** 配对按压时长标准差（左右键合并池；pressN≥2 时） */
  pressStd: number | null;
  /** 配对按压时长合并池的最大值 ms（pressN>0 时） */
  pressMaxMs: number | null;
  /** 配对按压时长合并池的中位数 ms（pressN>0 时）——触控板豁免判据（v4，<12ms） */
  pressMedianMs: number | null;
  /** 完全相同按压时长的众数值 ms（pressN>0 时；bit19 占比口径展示用） */
  pressModeMs: number | null;
  /** 众数精确占比 0~1（pressN>0 时；bit19 触发值） */
  pressModeShare: number | null;
  /** 格内偏移（x%16 / y%16 合并池）去重取值数（clicks>0 时） */
  offDistinct: number | null;
  /** 格内偏移标准差 px（clicks≥2 时） */
  offStd: number | null;
  /** 同刻（0ms）按压配对占全部按下比例（按下总数>0 时；含和弦手势膨胀，仅展示） */
  zeroPressFrac: number | null;
  /** 孤立同刻配对占比：同刻按下-松开且该时刻无其他点击事件、且前后
   *  DOUBLE_CLICK_WINDOW_MS 内无其他点击事件（和弦 lc|rc|lr、双击/快速连击
   *  都不算孤立——双击两次点击跨时间戳时各自成零时长对，是真人节奏）。
   *  孤立对＝单次点击快于时间粒度且无伴随点击＝合成流特征；真人观测上限
   *  15.5%，360671=61%；双击豁免后超快连击手（黎茜怡）归零。 */
  loneZeroPressFrac: number | null;
  // 点击节拍（bit22；360420 型「带抖动合成流」指纹）
  /** 空闲间隔（松开→下一次按下）样本数 */
  idleN: number;
  /** 空闲间隔精确众数值（ms；idleN>0 时） */
  idleModeMs: number | null;
  /** 众数精确占比（0~1；idleN>0 时） */
  idleModeShare: number | null;
}

export function humanLikeStats(v: ParsedVideo): HumanLikeStats {
  let clicks = 0, mv = 0;
  let mvPrevTs: number | null = null, mvMinDt: number | null = null;
  let burstRun = 1, maxMvBurst = 0;
  const offs: number[] = [];
  // 按压配对复用 pressPairStats 口径（0ms 不入时长池，但占 zeroFrac 分母）；
  // 孤立判定＝配对时刻除该按下外无其他点击事件（按时间戳计数）
  const presses: { L: number | null; R: number | null } = { L: null, R: null };
  const clickTs = new Map<number, number>();
  const durs: number[] = [];
  let totalPress = 0, zero = 0, loneZero = 0;
  // 先扫一遍建 clickTs（mv 无点击语义；lc/rc/sc/mc 计数按原始时间戳）
  const rawClickTs: number[] = [];
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const ev = m[2];
    if (ev === "lc" || ev === "rc" || ev === "mc" || ev === "sc") rawClickTs.push(parseFloat(m[1]) * 1000);
  }
  for (const t of rawClickTs) clickTs.set(t, (clickTs.get(t) ?? 0) + 1);
  // 双击/连击豁免（bit21，2026-11-13 张老师定）：孤立零对前后 250ms 内有其他
  // 点击事件 → 属于双击/快速连击节奏，不算孤立（真人触控板快速点按在 10ms
  // 量化下成零时长对，双击两次点击跨时间戳各自成对；生成器 360671 节拍 470ms+
  // 完全不受影响）。排序数组 + 二分找最近邻。
  const sortedClickTs = [...rawClickTs].sort((a, b) => a - b);
  const nearOtherClick = (ts: number): boolean => {
    let lo = 0, hi = sortedClickTs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedClickTs[mid]! < ts) lo = mid + 1; else hi = mid; }
    // sortedClickTs[lo] 是首个 ≥ ts 的元素；同刻其他点击已在 count 判定排除，
    // 这里只需看 lo-1（<ts）与 lo（=ts 自身则跳过看 lo+1）
    const prev = sortedClickTs[lo - 1];
    if (prev !== undefined && ts - prev <= DOUBLE_CLICK_WINDOW_MS) return true;
    let i = lo;
    while (i < sortedClickTs.length && sortedClickTs[i] === ts) i++;
    const next = sortedClickTs[i];
    return next !== undefined && next - ts <= DOUBLE_CLICK_WINDOW_MS;
  };
  // 点击节拍（bit22/23）：按下/松开时间序列（事件序），后置两指针算空闲间隔
  const pressTs: number[] = [];
  const releaseTs: number[] = [];
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const ts = parseFloat(m[1]) * 1000;
    const ev = m[2];
    const px = +m[5], py = +m[6];
    if (ev === "mv") {
      if (mv > 0 && mvPrevTs !== null) {
        const d = ts - mvPrevTs;
        if (mvMinDt === null || d < mvMinDt) mvMinDt = d;
        if (d <= MV_MIN_DT_TRIGGER_MS) burstRun++;
        else burstRun = 1;
        if (burstRun > maxMvBurst) maxMvBurst = burstRun;
      } else if (mv === 0) {
        maxMvBurst = 1;
      }
      mv++;
      mvPrevTs = ts;
      continue;
    }
    if (ev === "lc" || ev === "mc" || ev === "sc") { presses.L = ts; totalPress++; clicks++; pressTs.push(ts); }
    else if (ev === "rc") { presses.R = ts; totalPress++; clicks++; pressTs.push(ts); }
    else if (ev === "lr" || ev === "mr") {
      releaseTs.push(ts);
      if (presses.L !== null) {
        const d = ts - presses.L;
        if (d === 0) {
          zero++;
          // 孤立＝该时刻没有其他点击事件（和弦 lc|rc|lr / 双击连发是多点击同刻）
          // 且前后 250ms 内无其他点击（双击/快速连击序列豁免）
          if ((clickTs.get(presses.L) ?? 0) <= 1 && !nearOtherClick(presses.L)) loneZero++;
        } else if (d > 0) durs.push(d);
        presses.L = null;
      }
    } else if (ev === "rr") {
      releaseTs.push(ts);
      if (presses.R !== null) {
        const d = ts - presses.R;
        if (d === 0) {
          zero++;
          if ((clickTs.get(presses.R) ?? 0) <= 1 && !nearOtherClick(presses.R)) loneZero++;
        } else if (d > 0) durs.push(d);
        presses.R = null;
      }
    }
    if (px >= 0 && px < 60000 && py >= 0 && py < 60000) offs.push(px % 16, py % 16);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const std = (a: number[]) => {
    const mu = mean(a);
    if (mu === null || a.length < 2) return null;
    return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length);
  };
  const offMu = mean(offs);
  // 点击节拍：空闲间隔＝press[i] 与其前最近一次 release 的间隔（要求该 release
  // 晚于前一 press——排除按下期间连按与未配对残留）。按下/松开时间序列天然有序
  // （事件流时间序），两指针线性扫描。仅统计 ≥0ms 的间隔。
  const idle: number[] = [];
  {
    let ri = 0;
    for (let i = 1; i < pressTs.length; i++) {
      while (ri + 1 < releaseTs.length && releaseTs[ri + 1]! <= pressTs[i]!) ri++;
      const r = releaseTs[ri];
      if (r !== undefined && r > pressTs[i - 1]! && r <= pressTs[i]!) {
        const g = pressTs[i]! - r;
        if (g >= 0) idle.push(g);
      }
    }
  }
  let idleModeMs: number | null = null, idleModeShare: number | null = null;
  if (idle.length) {
    const h = new Map<number, number>();
    for (const g of idle) h.set(g, (h.get(g) ?? 0) + 1);
    let modeN = 0;
    for (const [val, n] of h) if (n > modeN) { modeN = n; idleModeMs = val; }
    idleModeShare = modeN / idle.length;
  }
  // 按压时长完全相同众数（bit19 占比口径，2026-11-13 张老师定）
  let pressModeMs: number | null = null, pressModeShare: number | null = null;
  if (durs.length) {
    const h = new Map<number, number>();
    for (const d of durs) h.set(d, (h.get(d) ?? 0) + 1);
    let modeN = 0;
    for (const [val, n] of h) if (n > modeN) { modeN = n; pressModeMs = val; }
    pressModeShare = modeN / durs.length;
  }
  return {
    clicks, mv,
    mvPerClick: clicks > 0 ? mv / clicks : null,
    mvMinDt,
    maxMvBurst,
    pressN: durs.length,
    pressStd: std(durs),
    pressMaxMs: durs.length ? Math.max(...durs) : null,
    pressMedianMs: (() => { if (!durs.length) return null; const s = [...durs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; })(),
    pressModeMs,
    pressModeShare,
    offDistinct: offs.length ? new Set(offs).size : null,
    offStd: offMu !== null && offs.length >= 2 ? std(offs) : null,
    zeroPressFrac: totalPress > 0 ? zero / totalPress : null,
    loneZeroPressFrac: totalPress > 0 ? loneZero / totalPress : null,
    idleN: idle.length,
    idleModeMs,
    idleModeShare,
  };
}

/** 人类相似度触发器组：返回命中的位码（bit17~22）。triageParsed 内联调用；
 *  存量补判脚本（scripts/trajectory-retriage.ts）直接复用做增量 OR。
 *  格式豁免（全站回扫实证，2026-11-12 本地 29.7 万免核定盘；2026-11-13 起豁免
 *  带数值守卫，见 CLIENT_MV_PER_CLICK_LEGAL_MIN 注释）：
 *  · 站内客户端（software=Saolei.wang / 带 evf_sig 签名）——落点本就格对齐、
 *    mv 事件较稀（浏览器 mousemove，mv/点击比合法低至 1.56）：豁免
 *    PATH_SPARSE / CLICK_OFFSET，但 mv/点击低于 1.56 时 PATH_SPARSE 豁免失效；
 *  · 老 Clone 0.97（全站 5.7 万盘，唯一在用版本）——其写流格式本身就是
 *    「点击落点=格中心（offDistinct=1）+ 瞬时点击同刻写 lc+lr（零占比可到 37.9%）
 *    + 每格跨界一条 mv（比值可到 1.7）」：豁免 PATH_SPARSE / CLICK_OFFSET /
 *    ZERO_PRESS，但 mv/点击低于 1.7 时 PATH_SPARSE 豁免失效。三路的反作弊火力
 *    由 PATH_DT / PRESS_UNIFORM（全软件适用、老Clone零命中）与既有触发器组承接。
 *  · 点击节拍组（bit22）全软件适用：节拍指纹来自时间戳本身，与写流格式
 *    无关（各软件人类长间隔区极值均 ≤0.162，低于触发线 0.23）。 */
export function humanLikeTriggers(hl: HumanLikeStats, software: string | null, clientOwned: boolean, level: string): number {
  const clone = software === "Clone";
  let bits = 0;
  if (hl.clicks >= TRAJ_MIN_CLICKS && hl.mv >= TRAJ_MIN_MV) {
    // 轨迹无密集采样：全软件适用（人类 mv 采样最稀的站内客户端 max 16ms、老 Clone max 10ms）
    if (hl.mvMinDt !== null && hl.mvMinDt > MV_MIN_DT_TRIGGER_MS) bits |= AUTO_REASON.PATH_DT;
    // 轨迹稀疏：比值低且全程无 ≥3 连密集采样串（慢速真人盘 mv/点击比可低到 1.29，
    // 但真实移动必现 ≥3 连密集串——2026-11-12 全站回扫 260087/260089 实证）；
    // 「补一对假事件」可绕 mvMinDt 但绕不过 burst<3
    // 豁免改数值守卫（2026-11-13 沈正刚 28122 案）：站内客户端/老 Clone 的豁免原先
    // 只看 software 名，合成流冒用站内软件名（mv/点击 0.78~0.81）仍被白免。比值低于
    // 本软件合法下限（站内 1.56 / Clone 1.7，2026-11-12 定标）时豁免失效照判——
    // 合法客户端物理上写不出低于下限的流。
    const legalMin = clone ? CLONE_MV_PER_CLICK_LEGAL_MIN : CLIENT_MV_PER_CLICK_LEGAL_MIN;
    const formatExempt17 = (clientOwned || clone) &&
      hl.mvPerClick !== null && hl.mvPerClick >= legalMin;
    if (!formatExempt17 &&
        hl.mvPerClick !== null && hl.mvPerClick < MV_PER_CLICK_TRIGGER &&
        hl.maxMvBurst < MIN_MV_BURST) {
      bits |= AUTO_REASON.PATH_SPARSE;
    }
    // 按压时长恒定（bit19，2026-11-13 张老师晚定改占比口径）：完全相同按压时长的
    // 众数占比 ≥ 分级线（初 95% / 中 85% / 高 75%）——确定性生成器特征（真人即快
    // 也有散布）。旧 σ<8ms 线误伤 Arbiter 10ms 量化下的按压偏快捷通真人，废弃。
    // 触控板豁免用中位数判据（v4，与 isTouchpadPress 同口径）。
    if (hl.pressN >= 30 &&
        !(hl.pressMedianMs !== null && hl.pressMedianMs < TOUCHPAD_MAX_PRESS_MS) &&
        hl.pressModeShare !== null &&
        hl.pressModeShare >= (PRESS_UNIFORM_SHARE[level] ?? 0.85)) {
      bits |= AUTO_REASON.PRESS_UNIFORM;
    }
    // 点击落点量化：站内客户端与老 Clone 豁免（两者落点=格中心是合法格式行为）
    if (!clientOwned && !clone &&
        (hl.offDistinct !== null && hl.offDistinct < CLICK_OFFSET_DISTINCT_TRIGGER ||
         hl.offStd !== null && hl.offStd < CLICK_OFFSET_STD_TRIGGER)) {
      bits |= AUTO_REASON.CLICK_OFFSET;
    }
  }
  // 孤立同刻按压占比：老 Clone 豁免（瞬时点击同刻配对是其写流格式）；clicks≥100
  // 守卫稀释少量胜局补洞合成对；用「孤立对」排除真人和弦手势同刻膨胀
  // （lc|rc|lr 和弦、双击连发都是多点击同刻；真人孤立占比观测上限 15.5%，
  // 360671=61%，线 30%）。站内客户端合成 sc+lr 对是孤立对但其占比 max 2.9%，照常适用
  if (!clone &&
      hl.clicks >= ZERO_PRESS_MIN_CLICKS && hl.loneZeroPressFrac !== null &&
      hl.loneZeroPressFrac > ZERO_PRESS_FRACTION_TRIGGER) {
    bits |= AUTO_REASON.ZERO_PRESS;
  }
  // 点击节拍（bit22，2026-11-12 钮志锋 360420/347805 案）：不依赖 mv 采样，
  // 独立于上方 clicks/mv 守卫。带抖动的合成流可以补齐结构特征（密集 mv、按压
  // 方差、落点散布），但「定时器节拍」在长间隔区（≥180ms）的精确聚集暴露生成器。
  // 真人高众数占比全部出现在快速节奏区（众数 30~150ms）；长间隔区真人极值
  // 0.162（全站回扫，11771 顾远 Clone 280ms）——触发线 0.23。
  // 全软件适用（Clone/Vienna/元/站内客户端人类极值均低于线，无需豁免）。
  // ⚠️ 50ms 窗口带聚集层已证伪删除：稳节奏真人窗口占比可达 61%（顾远 11767/
  // 11771），覆盖嫌疑盘 47%，带聚集维度与真人不可分（详见 limits 注释）。
  if (hl.idleN >= GAP_CADENCE_MIN_N && hl.idleModeMs !== null && hl.idleModeMs >= GAP_MODE_MIN_MS) {
    // bit22 精确节拍：同一精确长间隔重复占比过高（360420：230ms×21=30.9%）
    if (hl.idleModeShare !== null &&
        hl.idleModeShare >= GAP_MODE_SHARE_TRIGGER &&
        hl.idleModeShare * hl.idleN >= GAP_MODE_MIN_COUNT) {
      bits |= AUTO_REASON.GAP_MODE;
    }
  }
  return bits;
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

// ---------- 账号级按压聚合（bit24，2026-11-13 沈正刚 28122 案） ----------

export interface AccountPressStats {
  /** 参与统计的盘数（扫描窗口内 press 可统计：合并配对 n≥10） */
  usable: number;
  /** 各可统计盘的代表按压时长（左右键合并中位数）的账号级中位数（ms；usable=0 时 null） */
  medianMs: number | null;
  /** 触控板账号：账号代表按压中位数 <12ms（v4 口径——各盘取按压中位数为代表，
   *  偶发实体键长按不否决；2026-11-13 张老师定豁免） */
  touchpad: boolean;
}

/** 扫描上传者最近 ACCOUNT_PRESS_SCAN_LIMIT 盘（含正在分拣的当前盘——与存量
 *  补判口径一致，都是「该账号最近 30 盘」的整体视角），逐盘算 press 代表时长，
 *  聚合中位数。单盘读文件 + 解析 ~3ms，30 盘上限对上传链路无感。 */
export async function accountPressStatsOf(userId: number): Promise<AccountPressStats> {
  // VideoInfo 与 Video 无 Prisma 关联（同 id 平表），两步取最近 30 盘
  const vids = await prisma.video.findMany({
    where: { user: BigInt(userId) },
    select: { id: true },
    orderBy: { id: "desc" },
    take: ACCOUNT_PRESS_SCAN_LIMIT,
  });
  if (!vids.length) return { usable: 0, medianMs: null, touchpad: false };
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: vids.map((x) => x.id) } },
    select: { id: true, filepath: true },
  });
  const rows = [...infos];
  const reps: number[] = [];
  for (const info of rows) {
    const buf = readVideoFile(info.filepath);
    if (!buf) continue;
    const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
    const parsed = parseVideoBinary(buf, ext);
    if (!parsed) continue;
    const ps = pressPairStats(parsed);
    // 代表值用按压中位数（v4）——avg 被偶发长按拉高，会把触控板账号误判
    if (ps.pressMedianMs !== null && ps.leftN + ps.rightN >= PRESS_SHORT_MIN_PAIRS) {
      reps.push(ps.pressMedianMs);
    }
  }
  if (!reps.length) return { usable: 0, medianMs: null, touchpad: false };
  const sorted = [...reps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    usable: reps.length,
    medianMs: Math.round(median),
    // 触控板账号：账号代表按压中位数 <12ms（偶发实体键/换鼠标的盘被中位数稀释）
    touchpad: median < TOUCHPAD_MAX_PRESS_MS,
  };
}

/** bit24 判定：可统计盘数与中位数双门槛（口径见 ACCOUNT_PRESS_* 常量注释）；
 *  触控板账号豁免——触控板中位数天然 ≤12ms，不是合成流证据 */
export function accountPressHit(s: AccountPressStats): boolean {
  if (s.touchpad) return false;
  return s.usable >= ACCOUNT_PRESS_MIN_VIDEOS &&
    s.medianMs !== null && s.medianMs <= ACCOUNT_PRESS_MEDIAN_MS;
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
  trusted: boolean = false,
  clientOwned: boolean = false,
  software: string | null = null
): TriageResult {
  let reason = 0;

  const ps = pressPairStats(v);
  reason |= pressTriggers(ps, level);

  // 人类相似度触发器组（2026-11-12 红客合成录像 360671 案）：
  // 抓生成器写流的非人类结构特征（详见 humanLikeStats 注释与 limits 定标说明）。
  // 格式豁免口径（老 Clone / 站内客户端）见 humanLikeTriggers 注释。
  reason |= humanLikeTriggers(humanLikeStats(v), software, clientOwned, level);

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
  // bit4 点击数低于 ZiNi 下界（2026-10-31 张老师提议）：cl < zini＝物理不可能。
  // cl 优先 flop 重放口径（video_metrics.cl，与后台展示同源，自动双击 mr 计
  // Double++ 在内）；metrics 缺行/未传 cl 时回退事件流按下计数。
  // zini 由盘面现算（确定性贪心，同盘恒等值）；盘面缺失/长度不符时回退旧
  // cl<0.8×3BV 统计线兜底（宁可多捞不可漏放）。
  const cl = metrics?.cl ?? ps.cl;
  if (cl > 0 && v.bbbv !== null && v.bbbv > 0) {
    const boardOk = v.board && v.board.length === v.width * v.height;
    if (boardOk) {
      const zini = calZini(v.board, v.width, v.height);
      if (zini > 0 && cl < zini) reason |= AUTO_REASON.CLICK_FLOOR;
    } else if (cl < v.bbbv * CLICK_FLOOR_RATIO) {
      reason |= AUTO_REASON.CLICK_FLOOR;
    }
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
    // 站内客户端录像（排行/练习 evf 或自家 avf）＋软件名一并传入人类相似度
    // 触发器组做格式豁免（老 Clone / 站内客户端口径见 humanLikeTriggers 注释）
    const clientOwned = info.software === RANKED_SOFTWARE || info.evfSig !== null;
    const { flag: baseFlag, reason: baseReason } = triageParsed(
      parsed,
      video.level,
      metrics,
      lowTrust,
      {},
      info.realTime,
      trusted,
      clientOwned,
      info.software
    );
    let flag = baseFlag;
    let reason = baseReason;

    // 账号按压聚合（bit24，2026-11-13）：单盘触发器可以擦线伪装，账号级中位数
    // 难以连续伪装。30 盘 × ~3ms 读文件对上传链路无感；批量回填脚本走
    // account-press-retriage.ts 的按用户分组单遍扫描（每盘只解析一次），
    // 不经本入口（否则全站盘 × 30 读文件不可承受）。
    try {
      const acct = await accountPressStatsOf(Number(video.user));
      if (accountPressHit(acct)) {
        reason |= AUTO_REASON.ACCOUNT_PRESS;
        flag = 0;
      }
    } catch { /* 聚合失败不阻断主分拣 */ }

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
