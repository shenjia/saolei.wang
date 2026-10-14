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

/**
 * 二进制 → ParsedVideo（按扩展名选解析器）。
 * ⚠️ 解析器的入参类型在 Buffer ↔ Uint8Array 之间重构过（2026-10-14 别线在途），
 *    这里统一转成 Buffer 再传：Buffer 是 Uint8Array 的子类，两种签名都收得下，
 *    免得随解析器签名一变就构建报 TS2345。readFileSync 本就返回 Buffer，正常零拷贝。
 */
export function parseVideoBinary(buf: Uint8Array, ext: string): ParsedVideo | null {
  try {
    const b: Buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const lines = ext === "avf" ? avfToRawvf(b) : ext === "mvf" ? mvfToRawvf(b) : null;
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

  // ⚠️ 2026-10-14 修正（张老师查 328090 这条世界纪录录像时揪出来的）：
  // 一次「点击」在**松开**时才判定命中格，按下(lc/rc)与松开(lr/rr)常常落在不同格——
  // 甩鼠标是高手常态（实测这条录像前 12 个操作里有 8 次按下/松开不同格）。
  // 旧版以按下坐标为准，等于把一次点击记到隔壁格，最典型的症状是「已过审的胜局里还原出左键踩雷」
  // 这种不可能事件：体检 400 条有 278 条中招（avf 62%、mvf 50%），Ce / Corr / Path 三项全面失真。
  // 改成 press↔release 配对后同口径体检「踩雷=0」占比由 38% 升到 92%（见 topics/sync.md）。
  type Ev = { ts: number; ev: string; x: number; y: number; px: number; py: number };
  const inb = (e: Ev) => e.x >= 0 && e.y >= 0 && e.x < W && e.y < H;
  const idx = (e: Ev) => e.y * W + e.x;

  // 左键落在某格：已开→单键 chord（计 Double）／旗格→无效 Double／未开→开格
  const leftClick = (r: Ev) => {
    if (!inb(r)) return;
    const i = idx(r);
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
  };
  // 右键落在某格：未开→插旗／已旗→拔旗（拔旗另记 unflag）／已开→无事
  const rightClick = (r: Ev) => {
    if (!inb(r)) return;
    const i = idx(r);
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
  };
  const chordAt = (e: Ev) => {
    if (!inb(e)) return;
    counted(() => {
      clDouble++;
      chord(idx(e));
    });
  };

  let pendL: Ev | null = null;
  let pendR: Ev | null = null;
  for (const e of evs) {
    // 鼠标行程：所有带像素坐标的事件按时间序累加欧氏距离
    if (e.px !== 0 || e.py !== 0) {
      if (lastX !== null && lastY !== null) pathPx += Math.hypot(e.px - lastX, e.py - lastY);
      lastX = e.px;
      lastY = e.py;
    }
    if (e.ev === "lc") {
      // 残缺录像：上一次按下没记录到松开就又要按下，先按按下坐标补记，免得整次操作丢失
      if (pendL) leftClick(pendL);
      pendL = e;
    } else if (e.ev === "lr") {
      if (pendL) {
        leftClick(e); // ← 命中格取「松开」位置
        pendL = null;
      }
    } else if (e.ev === "rc") {
      if (pendL) {
        // 双键 chord：左右键同时按下即刻生效（不等松开），这次 rc 不插旗
        chordAt(e);
        pendL = null;
        pendR = null; // 随后的 lr/rr 属同一次手势，不再单独成操作
      } else {
        if (pendR) rightClick(pendR);
        pendR = e;
      }
    } else if (e.ev === "rr") {
      if (pendR) {
        rightClick(e); // ← 命中格取「松开」位置
        pendR = null;
      }
    } else if (e.ev === "sc" || e.ev === "mc") {
      chordAt(e);
    }
  }
  // 尾部兜底：录像在按下后直接结束（没记录松开）——按按下坐标补记，避免丢操作
  if (pendL) leftClick(pendL);
  if (pendR) rightClick(pendR);

  let flags = 0;
  for (let i = 0; i < N; i++) if (state[i] === 2) flags++;
  return { width: W, height: H, mines: v.mines, clLeft, clRight, clDouble, ce, unflag, pathPx, flags };
}

/**
 * 综合评分 STNB —— **纯函数，只需要 level / 3BV / 用时，不需要录像文件**。
 *
 * 这是它有别于其余五维的关键：服务端只需要 video_info 的 board_3bv、real_time 就能算，
 * 用于两种场景：
 *   ① 录像实体文件缺失的历史录像（跑批实测全站约 286/305,759 条）也能拿到综合排名；
 *   ② 将来若要脱离重放做「纯 SQL 全站榜」，可以直接在 SQL 里实现这个公式。
 *
 * 注意：虽然名叫「综合」，但它只由时间与 3BV 构成（CL / Ce / 鼠标路径一概不参与），
 * 与「速度」轴是同一份信息的两种折算。要真正融合六维需在此之上另行加权。
 *
 * @param solved 已解 3BV。原始公式末尾还有个完成度因子 √(solved/3BV)：
 *   本站只留已通过胜局，solved 恒等于全盘 3BV，该因子恒为 1，故一般传 solved 即可；
 *   将来若要评非胜局/半成品局，必须把该盘真实 3BV 也传进来，否则会系统性高估。
 * @param bbbv 全盘 3BV，默认等于 solved（胜局）
 */
export function stnbOf(level: string, solved: number, timeMs: number, bbbv: number = solved): number {
  if (!Number.isFinite(solved) || !Number.isFinite(timeMs)) return 0;
  if (solved <= 0) return 0;
  const t = timeMs / 1000;
  // 用时有下界才计算速度类指标（qg 在 t→0 时爆掉）。
  // 下界取 0.01s 而非更保守的值：站内确实有 1534 盘 3BV=2 的极短局（最快 0.09s），是有效成绩
  if (t < 0.01) return 0;
  const ln = level === "beg" ? 1 : level === "int" ? 2 : 3;
  const qg = Math.pow(t, 1.7) / solved;
  // 完成度因子：作弊式「只开一小片就收工」的半成品局会被按比例打折。
  // 胜局 solved === bbbv，恒为 1 —— 已入库的三十万盘数值不受影响，不必重算。
  const completion = bbbv > 0 ? Math.sqrt(solved / bbbv) : 0;
  return Math.round(((87.42 * ln * ln - 155.829 * ln + 115.708) / qg) * completion * 10) / 10;
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
  const path = Math.round(c.pathPx / CELL_PX);
  // 用时有下界才计算速度类指标（qg 在 t→0 时爆掉）。
  // 下界取 0.01s 而非更保守的值：站内确实有 1534 盘 3BV=2 的极短局（最快 0.09s），是有效成绩
  const valid = solved > 0 && t >= 0.01;
  const stnb = stnbOf(level, solved, timeMs);
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

/** 分位基准的最小样本量：不足则不产出该组（页面退化为不出雷达盒） */
export const MIN_DIST_SIZE = 30;

/**
 * 分位分组 = **级别 × 模式（标雷/无猜）**，不细分 3BV（张老师 2026-10-14 定）。
 *
 * 历史：初版按「级别 × 模式 × 精确 3BV」分组（bucket = 该盘 3BV 原值，507 行基准）。
 * 后改为只按级别 × 模式：① 不同 3BV 的盘没法横向比（3BV 越小越容易刷高 3BV/s）；
 * ② 细分后稀疏组合样本不足、要回退，口径反而不一致。现在全站只有 6 个组
 * （beg/int/exp × 标雷/无猜），每组样本万级，足够稳。
 *
 * video_metric_dist 的 bucket 列保留（唯一键的一部分），**恒写 -1**。
 */
export const DIST_BUCKET_ALL = -1;

// ---------- 指标定义与评级（移植 Assess::grade/percent 语义，纯函数便于跑批脚本复用） ----------

export type MetricKey = "stnb" | "bvs" | "ioe" | "corr" | "cls" | "ppc" | "cmp";
/** 重放得出、逐盘落库并建分位基准的六项客观事实（cmp 是合成的，不在内） */
export type BaseMetricKey = Exclude<MetricKey, "cmp">;
/** 参与综合加权的四根分项轴 */
export type AxisMetricKey = "bvs" | "ioe" | "corr" | "cls";

export interface MetricDef<K extends MetricKey = MetricKey> {
  key: K;
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

/**
 * 六项落库事实：重放得出的客观指标，逐盘存进 video_metrics，每一项都建分位基准。
 * 注意「移动 ppc」已按张老师 2026-10-14 要求移出雷达图，但值照旧落库留存
 * （重放结果是确定性事实，留着不占成本，将来想恢复随时可用）。
 */
export const BASE_METRICS: MetricDef<BaseMetricKey>[] = [
  { key: "stnb", name: "综合", desc: "综合评分 STNB", prefix: "STNB", unit: "", digits: 1, highIsBetter: true },
  { key: "bvs", name: "速度", desc: "每秒完成 3BV", prefix: "", unit: "3BV/s", digits: 3, highIsBetter: true },
  { key: "ioe", name: "效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true },
  { key: "corr", name: "精准", desc: "有效操作占比", prefix: "Corr", unit: "", digits: 3, highIsBetter: true },
  { key: "cls", name: "手速", desc: "每秒点击数", prefix: "", unit: "次/秒", digits: 2, highIsBetter: true },
  { key: "ppc", name: "移动", desc: "每击鼠标行程", prefix: "", unit: "格/次", digits: 2, highIsBetter: false },
];

/**
 * 雷达的四根分项轴 —— 自顶部「综合」起顺时针：速度 / 效率 / 精准 / 手速。
 * 综合分就是这四项在（级别 × 模式）组内百分位的加权平均，见 compositeOf。
 */
export const AXIS_METRICS: MetricDef<AxisMetricKey>[] = [
  { key: "bvs", name: "速度", desc: "每秒完成 3BV", prefix: "", unit: "3BV/s", digits: 3, highIsBetter: true },
  { key: "ioe", name: "效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true },
  { key: "corr", name: "精准", desc: "有效操作占比", prefix: "Corr", unit: "", digits: 3, highIsBetter: true },
  { key: "cls", name: "手速", desc: "每秒点击数", prefix: "", unit: "次/秒", digits: 2, highIsBetter: true },
];

export const BASE_METRIC_KEYS: BaseMetricKey[] = BASE_METRICS.map((m) => m.key);
export const AXIS_METRIC_KEYS: AxisMetricKey[] = AXIS_METRICS.map((m) => m.key);

/**
 * 综合分的权重（张老师 2026-10-14 定：只在「级别 × 模式」组内做百分位加权，
 * 不考虑 3BV，且不同级别不能放一起比较）。
 *
 * 现为**等权** —— 四项各占 1/4。要偏重某几项直接改这里的数字即可（不必改逻辑），
 * 改完跑一次批就会重算全站 composite 与组内排名。
 *
 * 为什么不用 STNB 当综合：STNB 只由「用时 + 3BV + 级别」构成，与「速度」轴是同一份
 * 信息的两种折算，用它排榜会被初级小局面垄断（实测 beg 3BV=2/0.09s 得 5671，
 * 而 exp 3BV=123/25.1s 的世界纪录只有 223）。百分位加权才跨 3BV 可比。
 */
export const COMPOSITE_WEIGHTS: Record<MetricKey, number> = {
  bvs: 1,
  ioe: 1,
  corr: 1,
  cls: 1,
  // 不参与加权：stnb 已被本分取代；ppc 已移出雷达；cmp 是本分自身
  stnb: 0,
  ppc: 0,
  cmp: 0,
};

/** 综合分 = 四轴组内百分位的加权平均（0-100，本身就是百分位量纲，可直接当综合轴的半径） */
export function compositeOf(percents: Partial<Record<MetricKey, number>>): number {
  let sum = 0;
  let wsum = 0;
  for (const def of AXIS_METRICS) {
    const w = COMPOSITE_WEIGHTS[def.key] ?? 0;
    if (w <= 0) continue;
    sum += (percents[def.key] ?? 0) * w;
    wsum += w;
  }
  return wsum > 0 ? Math.round((sum / wsum) * 10) / 10 : 0;
}

/**
 * 由百分位反推等级 —— 综合分本身就是百分位，没有独立的分布可建，
 * 所以走 GRADE_PERCENTS 档位表而不是 gradeOf（后者需要 dist 边界）。
 */
export function gradeFromPercent(p: number): string {
  if (!p) return "?";
  if (p >= GRADE_PERCENTS[0]) return GRADES[0];
  for (let i = 1; i < GRADE_PERCENTS.length; i++) {
    if (p > GRADE_PERCENTS[i]) {
      const upper = GRADE_PERCENTS[i - 1] - 1;
      const lower = GRADE_PERCENTS[i];
      const range = Math.abs(upper - lower);
      if (range === 0) return GRADES[i];
      const rate = Math.abs(upper - p) / range;
      if (rate > 0.6666) return GRADES[i] + "-";
      if (rate < 0.3333) return GRADES[i] + "+";
      return GRADES[i];
    }
  }
  return GRADES[GRADES.length - 1];
}

/** 指标值格式化（气泡展示），如 `STNB 87.0` / `4.065 3BV/s` */
export function formatMetric(key: MetricKey, value: number): string {
  const def = BASE_METRICS.find((m) => m.key === key);
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

/**
 * 档位内的插值上界。
 *
 * ⚠️ 原版 Assess::percent 这里是 `distribution[position-1] - 1` —— 那是**整数分**场景的
 * 产物（旧站 Distribution 阈值都是整数，减 1 表示「上一档的最高分」）。本站 IOE / Corr
 * 是 0~1 的比率，减 1 会把上界变成负数：实测 Corr=0.752 落在 [0.73, 0.77] 档内、
 * 真实约 55 分位，带 -1 的版本算出 49，**比本档下界 50 还低**，明显越界。
 * 连续量直接用上一档阈值当上界即可。
 */
function upperBound(dist: number[], position: number): number {
  return dist[position - 1];
}

/** 等级（SSS~F，含 +/-） */
export function gradeOf(value: number, dist: number[], highIsBetter: boolean): string {
  if (!value || dist.length === 0) return "?";
  const position = getPosition(value, dist, highIsBetter);
  if (position === 0 || position >= GRADES.length - 1) return GRADES[Math.min(position, GRADES.length - 1)];
  const maxScore = upperBound(dist, position);
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
  const maxPercent = GRADE_PERCENTS[position - 1] - 1; // 百分位档是整数档，减 1 正确（沿用原版）
  const minPercent = GRADE_PERCENTS[position];
  const maxScore = upperBound(dist, position); // 分数上界是连续量，不能减 1 —— 见 upperBound 注释
  const minScore = dist[position];
  const rangeScore = Math.abs(maxScore - minScore);
  if (rangeScore === 0) return minPercent;
  const offset = Math.abs(maxScore - value);
  const fix = Math.floor((offset * (maxPercent - minPercent)) / rangeScore);
  return Math.max(maxPercent - fix, 0);
}
