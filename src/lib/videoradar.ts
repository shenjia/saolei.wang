// 录像离线重放引擎：mvf/avf 二进制 → 事件流重放 → 六维技术指标
// 数据源：站内现有解析器（src/lib/{mvf,avf,rawvf}.ts），与上传校验 / 在线玩完全同源，
// 保证「页面看到的指标」与「录像文件里的真实操作」一致。
//
// 为什么必须重放：avf/mvf 头部只给了 Time / 3BV / Mode，没有总点击数、有效点击数，
// 鼠标行程更是只有事件流里有（坐标是像素级）。Clone 的 mvf 头部有 Left/Right/DoubleClicks
// 可作交叉校验，但 avf（Arbiter）没有，所以统一走重放，口径自洽。
//
// 两个钉死的口径（2026-10-14 对 963 盘真实 avf 实证）：
//  1) 胜局 solved3bv = 3BV：站内只收过审胜局。Arbiter 支持「标满旗获胜 / 自动完成」，
//     且 NF 盘结束时的自动展开不进事件流，实测 openedSafe 常比总安全格少 1-9，不是失败局。
//  2) 双键 chord 判定：lc 后 50ms 内出现**同格** rc 且落点未开未旗 → 双键手势（rc 不插旗，
//     记 Double）；rc 后接 lc（旗已插）→ lc 落在旗上，无效，Clone 同样记 Double。
//     Clone 的 LeftClicks = 左键落在未开格、RightClicks = rc 总数（含拔旗）、
//     DoubleClicks = 左键落在已开格 + 双键 chord —— 与 MVF 头部计数逐盘对齐。

import { GRADE_PERCENTS, GRADES } from "./config";
import { mvfToRawvf } from "./mvf";
import { avfToRawvf } from "./avf";
import { formatRawvf, type ParsedVideo } from "./rawvf";

/** 单盘原始计数（重放直出） */
export interface ReplayCounts {
  width: number;
  height: number;
  mines: number;
  /** 左键落在未开格（开格动作） */
  clLeft: number;
  /** 右键产生的插旗动作（含旗格上的往复） */
  clRight: number;
  /** 双键 chord + 左键落在已开格 + 左键落在旗格 */
  clDouble: number;
  /** 有效点击：该次操作真实改变了盘面（开格或有旗增减） */
  ce: number;
  /** 拔旗次数（右键落在旗格） */
  unflag: number;
  /** 鼠标行程（像素） */
  pathPx: number;
  /** 终盘插旗数 */
  flags: number;
}

/** 单盘六维指标 */
export interface VideoMetrics {
  level: string;
  noflag: boolean;
  /** 用时（毫秒） */
  timeMs: number;
  /** 3BV（由调用方兜底：解析不到时用库里 board_3bv） */
  bbbv: number;
  /** 总点击 = 左 + 右 + 双 */
  cl: number;
  clLeft: number;
  clRight: number;
  clDouble: number;
  ce: number;
  unflag: number;
  /** 鼠标行程（按 16px/格折算） */
  path: number;
  /** 速度：3BV/s */
  bvs: number;
  /** 效率：3BV / 总点击（最大值 1） */
  ioe: number;
  /** 精准：有效点击 / 总点击 */
  corr: number;
  /** 手速：总点击 / 秒 */
  cls: number;
  /** 移动：每击平均行程（格/次，越小越好） */
  ppc: number;
  /** 综合：按级别与难度归一化的 STNB 评分 */
  stnb: number;
}

const CELL_PX = 16; // 扫雷标准格边长，用于把像素行程折成「格」（跨软件无量纲）
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 二进制 → ParsedVideo（按扩展名选解析器） */
export function parseVideoBinary(buf: Uint8Array, ext: string): ParsedVideo | null {
  try {
    const lines = ext === "avf" ? avfToRawvf(buf) : ext === "mvf" ? mvfToRawvf(buf) : null;
    return lines ? formatRawvf(lines) : null;
  } catch {
    // 少数历史文件残缺（实测跑批每千余盘遇到一两个 mvf 提前 EOF），直接算无指标，不中断跑批
    return null;
  }
}

/**
 * 重放事件流，产出原始计数。
 * 网格状态：0 未开 / 1 已开 / 2 旗
 */
export function replayEvents(v: ParsedVideo): ReplayCounts {
  const W = v.width;
  const H = v.height;
  const N = W * H;
  const mines = new Uint8Array(N);
  for (let i = 0; i < N; i++) mines[i] = v.board[i] === "*" ? 1 : 0;
  const nums = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    if (mines[i]) {
      nums[i] = -1;
      continue;
    }
    let c = 0;
    const x = i % W;
    const y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (mines[ny * W + nx]) c++;
      }
    }
    nums[i] = c;
  }

  const state = new Uint8Array(N);
  const nb: number[][] = new Array(N);
  const neighbors = (i: number): number[] => {
    if (nb[i]) return nb[i];
    const x = i % W;
    const y = (i / W) | 0;
    const r: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) r.push(ny * W + nx);
      }
    }
    nb[i] = r;
    return r;
  };
  const flood = (i: number) => {
    if (state[i] !== 0 || mines[i]) return;
    const stack = [i];
    state[i] = 1;
    openedSafe++;
    while (stack.length) {
      const c = stack.pop() as number;
      if (nums[c] !== 0) continue;
      for (const a of neighbors(c)) {
        if (state[a] === 0 && !mines[a]) {
          state[a] = 1;
          openedSafe++;
          stack.push(a);
        }
      }
    }
  };
  const chord = (i: number) => {
    if (state[i] !== 1 || nums[i] <= 0) return;
    const around = neighbors(i);
    let f = 0;
    for (const a of around) if (state[a] === 2) f++;
    if (f !== nums[i]) return;
    for (const a of around) if (state[a] === 0 && !mines[a]) flood(a);
  };

  let clLeft = 0;
  let clRight = 0;
  let clDouble = 0;
  let ce = 0;
  let unflag = 0;
  let flagToggles = 0; // 旗状态实际翻转次数（供 Ce 判定）
  let openedSafe = 0;
  let pathPx = 0;
  let lastX: number | null = null;
  let lastY: number | null = null;

  const counted = (fn: () => void) => {
    const before = openedSafe * 1024 + flagToggles;
    fn();
    if (openedSafe * 1024 + flagToggles !== before) ce++;
  };

  // 事件行形态：`ts ev x y (px py)`，坐标为 1-based
  const evs: { ts: number; ev: string; x: number; y: number; px: number; py: number }[] = [];
  for (const line of v.events) {
    const m = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (!m) continue;
    evs.push({
      ts: parseFloat(m[1]),
      ev: m[2],
      x: +m[3] - 1,
      y: +m[4] - 1,
      px: +m[5],
      py: +m[6],
    });
  }

  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    // 鼠标行程：所有带像素坐标的事件按时间序累加欧氏距离
    if (e.px !== 0 || e.py !== 0) {
      if (lastX !== null && lastY !== null) pathPx += Math.hypot(e.px - lastX, e.py - lastY);
      lastX = e.px;
      lastY = e.py;
    }
    if (e.x < 0 || e.y < 0 || e.x >= W || e.y >= H) continue;
    const i = e.y * W + e.x;
    if (e.ev === "lc") {
      const nxt = evs[k + 1];
      const twinRc =
        nxt && nxt.ev === "rc" && nxt.x === e.x && nxt.y === e.y && nxt.ts - e.ts <= 0.05;
      if (twinRc && state[i] === 0) {
        // 双键 chord：配对的 rc 不插旗（Clone 的手势层判定）
        counted(() => {
          clDouble++;
          chord(i);
        });
        k++;
        continue;
      }
      if (state[i] === 1) {
        counted(() => {
          clDouble++;
          chord(i);
        });
      } else if (state[i] === 2) {
        clDouble++; // 左键落在旗格：无效果，Clone 同样计 Double
      } else {
        clLeft++;
        counted(() => flood(i));
      }
    } else if (e.ev === "rc") {
      if (state[i] === 0) {
        clRight++;
        counted(() => {
          state[i] = 2;
          flagToggles++;
        });
      } else if (state[i] === 2) {
        unflag++;
        counted(() => {
          state[i] = 0;
          flagToggles++;
        });
      }
    } else if (e.ev === "sc" || e.ev === "mc") {
      counted(() => {
        clDouble++;
        chord(i);
      });
    }
  }

  let flags = 0;
  for (let i = 0; i < N; i++) if (state[i] === 2) flags++;
  return { width: W, height: H, mines: v.mines, clLeft, clRight, clDouble, ce, unflag, pathPx, flags };
}

/**
 * 二进制 → 六维指标
 * @param opts.timeMs 库内权威用时（video_info.real_time）。**必须传**：实测 1119 盘早期 mvf
 *   的文件内 Time 与站内成绩不一致（个别解析出 0.01s 这种垃圾值，会把 3BV/s 顶到几万），
 *   页面标题的 3BV/s 也走库里这个值，雷达必须同源。
 * @param opts.bbbv 库内权威 3BV（video_info.board_3bv），文件里没有 3BV 时（pre-0.97）兜底
 */
export function analyzeVideo(
  buf: Uint8Array,
  ext: string,
  opts?: {
    level?: string;
    noflag?: boolean;
    bbbvFallback?: number;
    timeMs?: number;
    bbbv?: number;
  }
): VideoMetrics | null {
  const v = parseVideoBinary(buf, ext);
  if (!v) return null;
  const c = replayEvents(v);
  const bbbv = opts?.bbbv && opts.bbbv > 0 ? opts.bbbv : v.bbbv ?? opts?.bbbvFallback ?? 0;
  const parsedTime = v.timeMs;
  const timeMs = opts?.timeMs && opts.timeMs > 0 ? opts.timeMs : parsedTime;
  const t = timeMs / 1000;
  const cl = c.clLeft + c.clRight + c.clDouble;
  // 胜局口径：solved3bv = 3BV（见文件头注记）
  const solved = bbbv;
  const level = opts?.level ?? v.level;
  const ln = level === "beg" ? 1 : level === "int" ? 2 : 3;
  const path = Math.round(c.pathPx / CELL_PX);
  // 用时有下界才计算速度类指标（qg 在 t→0 时爆掉）。
  // 下界取 0.01s 而非更保守的值：站内确实有 1534 盘 3BV=2 的极短局（最快 0.09s），是有效成绩
  const valid = solved > 0 && t >= 0.01;
  const qg = valid ? Math.pow(t, 1.7) / solved : 0;
  const stnb = valid ? (((87.42 * ln * ln - 155.829 * ln + 115.708) / qg) * Math.sqrt(solved / bbbv)) : 0;
  return {
    level,
    noflag: opts?.noflag ?? v.noflag,
    timeMs,
    bbbv,
    cl,
    clLeft: c.clLeft,
    clRight: c.clRight,
    clDouble: c.clDouble,
    ce: c.ce,
    unflag: c.unflag,
    path,
    bvs: valid ? r3(solved / t) : 0,
    ioe: cl > 0 ? r3(solved / cl) : 0,
    corr: cl > 0 ? r3(c.ce / cl) : 0,
    cls: valid ? r3(cl / t) : 0,
    ppc: cl > 0 ? r3(path / cl) : 0,
    stnb: Math.round(stnb * 10) / 10,
  };
}

/** 分位基准的最小样本量：不足则回退到「全组」行（bucket = -1） */
export const MIN_DIST_SIZE = 30;

/**
 * 分位分组的 bucket 取值 = **该盘的 3BV 原值**（张老师要求「本级别同等 3BV 下」比较）。
 * 实测按单 3BV 分组的样本量足以支撑：beg 81/95、int 165/201、exp 255/331 个
 * (级别, 模式, 3BV) 组合样本 ≥ 30；稀疏组合由 video_metric_dist 的 -1 全组行兜底。
 */
export function bbbvBucket(_level: string, bbbv: number): number {
  return bbbv;
}

// ---------- 六维定义与评级（移植 Assess::grade/percent 语义，纯函数便于跑批脚本复用） ----------

export type MetricKey = "stnb" | "bvs" | "ioe" | "corr" | "cls" | "ppc";

export interface MetricDef {
  key: MetricKey;
  /** 雷达轴名 */
  name: string;
  /** hover 气泡里的完整说明 */
  desc: string;
  /** 数值前缀（STNB / IOE / Corr 这类指标名即单位） */
  prefix: string;
  /** 单位（跟在数值后） */
  unit: string;
  /** 小数位 */
  digits: number;
  /** 是否「越大越好」（移动轴是唯一反向轴） */
  highIsBetter: boolean;
}

/** 六轴顺序：自顶部起顺时针（张老师 2026-10-14 定：综合置顶） */
export const METRICS: MetricDef[] = [
  { key: "stnb", name: "综合", desc: "综合评分 STNB", prefix: "STNB", unit: "", digits: 1, highIsBetter: true },
  { key: "bvs", name: "速度", desc: "每秒完成 3BV", prefix: "", unit: "3BV/s", digits: 3, highIsBetter: true },
  { key: "ioe", name: "效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true },
  { key: "corr", name: "精准", desc: "有效操作占比", prefix: "Corr", unit: "", digits: 3, highIsBetter: true },
  { key: "cls", name: "手速", desc: "每秒点击数", prefix: "", unit: "次/秒", digits: 2, highIsBetter: true },
  { key: "ppc", name: "移动", desc: "每击鼠标行程", prefix: "", unit: "格/次", digits: 2, highIsBetter: false },
];

export const METRIC_KEYS: MetricKey[] = METRICS.map((m) => m.key);

/** 指标值格式化（气泡展示），如 `STNB 87.0` / `4.065 3BV/s` */
export function formatMetric(key: MetricKey, value: number): string {
  const def = METRICS.find((m) => m.key === key);
  if (!def) return String(value);
  const num = value.toFixed(def.digits);
  return [def.prefix, num, def.unit].filter((s) => s !== "").join(" ");
}

/** 线性插值分位数（升序数组，p 为 0-100） */
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 由样本值构建 9 档分位边界（与 GRADES / GRADE_PERCENTS 同位序）。
 * dist[0] 对应 GRADE_PERCENTS[0]=100（最强），所以：
 *   越大越好 → 边界降序（QG 同理）；越小越好（移动轴）→ 边界升序。
 * 注意：单调性修正循环**必须加花括号**——写成
 * `if (A) for (...) if (B) X; else Y;` 会触发悬空 else（2026-10-14 实测踩过）。
 */
export function buildDist(values: number[], highIsBetter: boolean): number[] {
  const s = [...values].map(Number).sort((a, b) => a - b);
  const dist = GRADE_PERCENTS.map((g) => quantile(s, highIsBetter ? g : 100 - g));
  if (highIsBetter) {
    for (let i = 1; i < dist.length; i++) if (dist[i] > dist[i - 1]) dist[i] = dist[i - 1];
  } else {
    for (let i = 1; i < dist.length; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];
  }
  return dist;
}

/** 移植 Assess::getPosition（末尾档位钳位，避免 GRADES[9] = undefined） */
function getPosition(value: number, dist: number[], highIsBetter: boolean): number {
  for (let i = 0; i < dist.length; i++) {
    if (highIsBetter ? value >= dist[i] : value <= dist[i]) return i;
  }
  return Math.min(dist.length, GRADES.length - 1);
}

/** 等级（SSS~F，含 +/-） */
export function gradeOf(value: number, dist: number[], highIsBetter: boolean): string {
  if (!value || dist.length === 0) return "?";
  const position = getPosition(value, dist, highIsBetter);
  if (position === 0 || position >= GRADES.length - 1) return GRADES[Math.min(position, GRADES.length - 1)];
  const maxScore = dist[position - 1] - 1;
  const minScore = dist[position];
  const range = Math.abs(maxScore - minScore);
  if (range === 0) return GRADES[position];
  const rate = Math.abs(maxScore - value) / range;
  if (rate > 0.6666) return GRADES[position] + "-";
  if (rate < 0.3333) return GRADES[position] + "+";
  return GRADES[position];
}

/** 超越百分比（0-100） */
export function percentOf(value: number, dist: number[], highIsBetter: boolean): number {
  if (!value || dist.length === 0) return 0;
  const position = getPosition(value, dist, highIsBetter);
  if (position === 0) return GRADE_PERCENTS[0];
  const maxPercent = GRADE_PERCENTS[position - 1] - 1;
  const minPercent = GRADE_PERCENTS[position];
  const maxScore = dist[position - 1] - 1;
  const minScore = dist[position];
  const rangeScore = Math.abs(maxScore - minScore);
  if (rangeScore === 0) return minPercent;
  const offset = Math.abs(maxScore - value);
  const fix = Math.floor((offset * (maxPercent - minPercent)) / rangeScore);
  return Math.max(maxPercent - fix, 0);
}
