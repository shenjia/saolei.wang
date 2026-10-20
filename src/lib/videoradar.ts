// 录像离线重放引擎：mvf/avf/rmv 二进制 → 事件流重放 → 六维技术指标
// 数据源：站内现有解析器（src/lib/{mvf,avf,rmv,rawvf}.ts），与上传校验 / 在线玩完全同源，
// 保证「页面看到的指标」与「录像文件里的真实操作」一致。
//
// 为什么必须重放：avf/mvf 头部只给了 Time / 3BV / Mode，没有总点击数、有效点击数，
// 鼠标行程更是只有事件流里有（坐标是像素级）。Clone 的 mvf 头部有 Left/Right/DoubleClicks
// 可作交叉校验，但 avf（Arbiter）没有，所以统一走重放，口径自洽。
//
// ⚠️ 口径基准（2026-10-16 五轮修正）：**flop 官方引擎（模块 5fd3 VideoParser）源码 1:1**，
//   与 videowin.ts（胜负判定）/ VideoReplay.tsx（原地回放）同一状态机（lp/lv/rp/rv/mp/sv+marks）。
//   此前 10-14 版的 press↔release 配对口径只迁了胜负判定、漏迁了本统计引擎，
//   在 1.5 击（rc lc lr rr）打法上 L/D 镜像偏移、旗落在松开位导致 chord 大面积失效，
//   342232 对照原真 flop：Cl 185 vs 180、Ce 86 vs 159、Corr 0.465 vs 0.883。
//   flop 计数语义（源码 leftRelease/rightPress/rightRelease/middleRelease）：
//     · lr：rp||sv 时＝双击（Double++，openAround 松开位）；lv 时＝左键（Left++，open 松开位）；
//     · rc：lp 按住时仅视觉不计数不插旗；否则 toggleLabel 改变盘面→Right++（按下位即刻生效），
//           未改变盘面→挂 rv，待 rr 时 Right++ 且计 wasted；
//     · rr：lp 按住时＝双击（Double++）；否则 rv 挂起时 Right++（wasted）；
//     · mr：双击（Double++）；
//     · Ce ＝ Cl −（wastedLeft + wastedRight + wastedDouble），与 flop Counters 一致。
//   「胜局 solved3bv = 3BV」口径不变（10-14 实证，AVF NF 盘尾部自动展开不进事件流）。

import { mvfToRawvfBest } from "./mvf-best";
import { avfToRawvf } from "./avf";
import { rmvToRawvf } from "./rmv";
import { formatRawvf, type ParsedVideo } from "./rawvf";
import { replayCounts, type NormEvent, type ReplayCounts } from "./replay-core";

/* 指标定义 / 分位评级 / 等级配色已拆到 lib/videoscore.ts（纯函数，客户端可直接引）。
   这里原样再导出一份，scripts/video-metrics.ts、lib/videoanalysis.ts 等老调用方的
   import 路径不必改动。改评级口径请改 videoscore.ts —— 录像页与在线玩结算面板共用。 */
export * from "./videoscore";
/* 重放状态机已拆到 lib/replay-core.ts（2026-10-16）：录像侧与在线练习结算共用同一
   事实源。ReplayCounts 在这里再导出，老调用方 import 路径不变。 */
export type { ReplayCounts } from "./replay-core";

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
  /** QG 质量分（越小越好）= (用时秒)^1.7 ÷ 已解 3BV，STNB 的中间量 */
  qg: number;
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
    const lines =
      ext === "avf"
        ? avfToRawvf(b)
        : ext === "mvf"
          ? (mvfToRawvfBest(b)?.lines ?? null) // 择优口径：雷达指标与判定/回放同源（mvf-best.ts）
          : ext === "rmv"
            ? rmvToRawvf(b)
            : null;
    return lines ? formatRawvf(lines) : null;
  } catch {
    // 少数历史文件残缺（实测跑批每千余盘遇到一两个 mvf 提前 EOF），直接算无指标，不中断跑批
    return null;
  }
}

/**
 * 重放事件流，产出原始计数 —— 状态机在 lib/replay-core.ts（全站唯一事实源），
 * 这里只负责把 rawvf 文本行解析成规范化事件。坐标为 1-based → 0-based。
 * 真实录像一律按 flop 原样口径（不传 noflag；NF 录像里的 rc 事件 flop 照样 toggleLabel）。
 */
export function replayEvents(v: ParsedVideo): ReplayCounts {
  const mines = new Uint8Array(v.width * v.height);
  for (let i = 0; i < mines.length; i++) mines[i] = v.board[i] === "*" ? 1 : 0;

  // 事件行形态：`ts ev x y (px py)`（mt＝切换问号开关，不占格子）
  const evs: NormEvent[] = [];
  for (const line of v.events) {
    const m = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (!m) continue;
    evs.push({
      ev: m[2] as NormEvent["ev"],
      x: +m[3] - 1,
      y: +m[4] - 1,
      px: +m[5],
      py: +m[6],
    });
  }
  return replayCounts(
    { width: v.width, height: v.height, mines: v.mines, board: mines },
    evs,
    { marks: v.marks ?? false }
  );
}

/**
 * QG 质量分 —— **纯函数，只需要 solved 3BV / 用时**（与 stnbOf 同一批输入）。
 * QG = (用时秒)^1.7 ÷ solved；越小越好。是 STNB 的直接中间量：
 * STNB = 难度系数 ÷ QG × 完成度因子。
 * 2026-10-20 起随 video_metrics 落库（此前只在回放/结算面板实时现算）。
 */
export function qgOf(solved: number, timeMs: number): number {
  if (!Number.isFinite(solved) || !Number.isFinite(timeMs)) return 0;
  if (solved <= 0) return 0;
  const t = timeMs / 1000;
  if (t < 0.01) return 0;
  return Math.round((Math.pow(t, 1.7) / solved) * 1000) / 1000;
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
  // 2026-10-16 张老师定：难度常数更新为 初级 36 / 中级 162 / 高级 435，
  // 过这三点的二次系数 = (73.5, -94.5, 57)（87.42/-155.829/115.708 是旧常数）。
  return Math.round(((73.5 * ln * ln - 94.5 * ln + 57) / qg) * completion * 10) / 10;
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
    qg: qgOf(solved, timeMs),
  };
}
