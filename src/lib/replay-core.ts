// 事件重放统计核心 —— flop 官方引擎（模块 5fd3 VideoParser）1:1 状态机。
// **全站唯一点击统计事实源**（2026-10-16 重构）：
//   · 录像侧：videoradar.replayEvents 把 rawvf 文本行解析成 NormEvent 后走这里；
//   · 在线练习：OnlinePlay 结算时对当局事件流走这里（不再用实时计数器）。
// 状态机 lp/lv/rp/rv/sv+marks 与 videowin.ts（胜负判定）/ VideoReplay.tsx（原地回放）同源。
//
// flop 计数语义（源码 leftRelease/rightPress/rightRelease/middleRelease）：
//   · lr：rp||sv 时＝双击（Double++，openAround 松开位）；lv 时＝左键（Left++，open 松开位）；
//   · rc：lp 按住时仅视觉不计数不插旗；否则 toggleLabel 改变盘面→Right++（按下位即刻生效），
//         未改变盘面→挂 rv，待 rr 时 Right++ 且计 wasted；
//   · rr：lp 按住时＝双击（Double++）；否则 rv 挂起时 Right++（wasted）；
//   · mr：双击（Double++）——在线练习的「自动双击」也录这个码；
//   · Ce ＝ Cl −（wastedLeft + wastedRight + wastedDouble），与 flop Counters 一致。
//
// ⚠️ 本文件必须是**零依赖纯函数模块**——OnlinePlay 在客户端引用它，
//    不许 import 任何 Node 侧的东西（Buffer/fs/解析器），否则客户端 bundle 会炸。

/** 规范化事件：x/y 为 0-based 格坐标（越界点击给 -1 等非法值，引擎照样计 wasted 不落地），px/py 为像素 */
export interface NormEvent {
  ev: "mv" | "lc" | "lr" | "rc" | "rr" | "mc" | "mr" | "sc" | "mt";
  x: number;
  y: number;
  px: number;
  py: number;
}

/** 重放盘面：board 为 0/1 雷区数组（行优先，长度 = width×height） */
export interface ReplayBoard {
  width: number;
  height: number;
  mines: number;
  board: Uint8Array | number[];
}

/** 单盘原始计数（重放直出，flop 口径） */
export interface ReplayCounts {
  width: number;
  height: number;
  mines: number;
  /** 左键点击数（flop LeftClicks） */
  clLeft: number;
  /** 右键点击数（flop RightClicks：按下即盘面变化 + 挂起补记） */
  clRight: number;
  /** 双击数（flop DoubleClicks：chord 手势 + 中键/自动双击） */
  clDouble: number;
  /** 有效点击：Cl − wasted（flop Ce） */
  ce: number;
  /** 无效左键（flop wastedLeftClicks：open 落旗/已开格/越界） */
  wastedLeft: number;
  /** 无效右键（flop wastedRightClicks） */
  wastedRight: number;
  /** 无效双击（flop wastedDoubleClicks：chord 没开出格） */
  wastedDouble: number;
  /** 拔旗次数（rc 落在旗格；仅参考，不参与 flop 计数） */
  unflag: number;
  /** 鼠标行程（像素，事件流坐标欧氏累加） */
  pathPx: number;
  /**
   * 跨格次数（2026-10-29）：鼠标轨迹跨过格线的次数——行程段按 0.5px 步长光栅化，
   * 每进入一个新格 +1（对角跨角也只记 1 次）。格内抖动/噪声一次跨格都不产生，
   * 对鼠标回报率**构造性免疫**（连续 PATH 逐事件欧氏累加，采样越密抖动进得越多）。
   * 「路线规划」轴（完成3BV/Crossings）的分母；探针实测 6/6 组技能区分度优于 PATH
   * （scripts/cellpath-probe.ts，与插桩版对账零失败后并入本状态机）。
   */
  crossings: number;
  /** 终盘插旗数 */
  flags: number;
  /**
   * 终态旗位图（2026-10-31 张老师需求：录像封面显示玩家标过的雷）：
   * 1＝终局仍插旗（纯玩家行为——胜局引擎自动补旗不经事件流，不会虚高）。
   * 调用方据此合成含旗 board 串（雷上旗=F / 非雷旗=X）落库 video_info.board。
   */
  flagged: Uint8Array;
  /**
   * 已完成 3BV（2026-10-30 张老师定：bpp 分子用完成 3BV 而非总 3BV）：
   * 重放终态按站内 3BV 构件（region 全开算 1 / singles 开算 1）扫描——
   * 胜局恒等于全盘 3BV，未完成局只算真实开到的部分
   */
  solvedBv: number;
}

/** AVF 鼠标字节码 → 事件名（与 avf.ts 解析器 / avfwrite.ts 生成器同一约定） */
export const MOUSE_CODE_TO_EV: Record<number, NormEvent["ev"]> = {
  1: "mv", 3: "lc", 5: "lr", 9: "rc", 17: "rr", 33: "mc", 65: "mr",
  145: "rr", 193: "mr", 11: "sc", 21: "lr",
};

export interface ReplayOptions {
  /** 问号标记开关初始态（mt 事件会翻转它） */
  marks?: boolean;
  /**
   * NF 禁旗模式（仅在线练习传；真实录像文件一律缺省 false 走 flop 原样口径）。
   * true 时 rc 不切旗（与 live 的 NF 抖动守卫一致）：计 Right++ 且直接计 wasted，
   * 不在重放盘面留下幽灵旗——否则 chord 会在重放里「假满足」，与玩家真实盘面分叉。
   */
  noflag?: boolean;
}

/**
 * 重放事件流，产出原始计数 —— flop 官方引擎 1:1。
 * 网格状态：0 未开 / 1 已开；flagged / questioned 单独两维（flop Cell.questioned）。
 * 越界点击（i<0）：flop open/openAround 返回 false → 照样计数、计 wasted，不落地。
 */
export function replayCounts(
  board: ReplayBoard,
  events: NormEvent[],
  opts?: ReplayOptions
): ReplayCounts {
  const W = board.width;
  const H = board.height;
  const N = W * H;
  const mines = new Uint8Array(N);
  for (let i = 0; i < N; i++) mines[i] = board.board[i] ? 1 : 0;
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

  const state = new Uint8Array(N); // 0 未开 / 1 已开
  const flagged = new Uint8Array(N);
  const questioned = new Uint8Array(N);
  let dead = false; // chord/lc 展开遇雷（flop Blast）——胜局录像不该出现，保真用
  const flagsAround = (i: number): number => {
    const x = i % W;
    const y = (i / W) | 0;
    let f = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (flagged[ny * W + nx]) f++;
      }
    }
    return f;
  };
  /** flop open(i)：开单格（含踩雷 Blast、0 号泛洪）；返回是否真的开了 */
  let openedSafe = 0;
  const openCell = (i: number): boolean => {
    if (i < 0 || i >= N || state[i] !== 0 || flagged[i]) return false;
    state[i] = 1;
    if (mines[i]) {
      dead = true;
      return true;
    }
    openedSafe++;
    if (nums[i] === 0) openAroundIdx(i);
    return true;
  };
  /** flop openAround(i)：仅该格已开且（0 号或旗数齐）才开 3x3 邻域（可开雷→dead） */
  const openAroundIdx = (i: number): boolean => {
    if (i < 0 || i >= N || state[i] !== 1) return false;
    if (!(nums[i] === 0 || nums[i] === flagsAround(i))) return false;
    const x = i % W;
    const y = (i / W) | 0;
    let any = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        any = openCell(ny * W + nx) || any;
      }
    }
    return any;
  };

  // flop toggleLabel：旗→问号(marks)/摘旗、问号→清、未标→旗；返回是否动了格子
  let unflag = 0; // 摘旗/清问号计数（站内参考字段）
  const toggleLabel = (i: number, marks: boolean): boolean => {
    if (state[i] === 1) return false;
    if (marks && flagged[i]) {
      flagged[i] = 0;
      questioned[i] = 1;
    } else if (flagged[i]) {
      flagged[i] = 0;
      questioned[i] = 0;
      unflag++;
    } else if (questioned[i]) {
      flagged[i] = 0;
      questioned[i] = 0;
      unflag++;
    } else {
      flagged[i] = 1;
      questioned[i] = 0;
    }
    return true;
  };

  let clLeft = 0;
  let clRight = 0;
  let clDouble = 0;
  let wastedLeft = 0;
  let wastedRight = 0;
  let wastedDouble = 0;
  let pathPx = 0;
  let lastX: number | null = null;
  let lastY: number | null = null;

  // 跨格计数：与 pathPx 同一坐标链（含哨兵断链语义）。lastCell 是上一个所在格，
  // 断链（哨兵坐标/首事件）后重置为 -1，从下一个合法坐标重新起算。
  let crossings = 0;
  let lastCell = -1;
  const cellOf = (px: number, py: number): number => {
    const cx = Math.floor(px / 16);
    const cy = Math.floor(py / 16);
    if (cx < 0 || cx >= W || cy < 0 || cy >= H) return -1;
    return cy * W + cx;
  };

  // flop 状态机（与 videowin.ts 同源；本函数额外产出计数）
  let lp = false,
    lv = false,
    rp = false,
    rv = false,
    sv = false;
  let marks = opts?.marks ?? false;
  const noflag = opts?.noflag ?? false;
  let over = false; // Win/Lose 后事件无效（flop performEvent 守卫）
  const safeTotal = N - board.mines;

  for (const e of events) {
    if (over) break;
    // 鼠标行程：所有带像素坐标的事件按时间序累加欧氏距离（flop mouseMove 同款）。
    // rmv 哨兵坐标豁免：Vienna 格式在窗口失焦等场景写 ~6552x 的哨兵值（2026-10-23
    // 实证 259991 库存 path 8249 格 vs 真实 55 格，133/261 条 rmv 的 path 被污染）——
    // 哨兵本身不计行程，且断开位移链（哨兵前后的正常坐标不跨它连成巨量假位移）
    if ((e.px !== 0 || e.py !== 0) && e.px < 60000 && e.py < 60000) {
      if (lastX !== null && lastY !== null) {
        const seg = Math.hypot(e.px - lastX, e.py - lastY);
        pathPx += seg;
        // 跨格光栅化：段内按 0.5px 步长重走一遍（与探针 replayCells 1:1；0.5px 远小于
        // 16px 格宽，漏检可忽略），每进入一个与上次不同的格 +1。段首先无脑记一次——
        // 段与段之间必然换坐标，但「是否跨格」由 prevCell 判定，同格抖动不计。
        const steps = Math.max(1, Math.ceil(seg * 2));
        let prevCell = lastCell;
        for (let t = 0; t <= steps; t++) {
          const px = lastX + ((e.px - lastX) * t) / steps;
          const py = lastY + ((e.py - lastY) * t) / steps;
          const idx = cellOf(px, py);
          if (idx < 0) {
            // 出界（窗口边缘甩出去的坐标）：断链，回来后重新起算
            prevCell = -1;
            continue;
          }
          if (idx !== prevCell) {
            crossings++;
            prevCell = idx;
          }
        }
        lastCell = prevCell;
      } else {
        lastCell = cellOf(e.px, e.py);
      }
      lastX = e.px;
      lastY = e.py;
    } else {
      lastX = null;
      lastY = null;
      lastCell = -1;
    }
    if (e.ev === "mt") {
      marks = !marks;
      continue;
    }
    if (e.ev === "mv") continue;
    const i = e.y * W + e.x;
    const inside = i >= 0 && i < N && e.x >= 0 && e.x < W && e.y >= 0 && e.y < H;
    switch (e.ev) {
      case "lc":
        lp = lv = true;
        break;
      case "lr": {
        // flop leftRelease：rp||sv → 双击；否则 lv → 左键开格（松开坐标）
        if (rp || sv) {
          clDouble++;
          if (!openAroundIdx(inside ? i : -1)) wastedDouble++;
        } else if (lv) {
          clLeft++;
          if (!openCell(inside ? i : -1)) wastedLeft++;
        }
        lp = lv = rv = sv = false; // 不动 rp（flop 原样）
        break;
      }
      case "rc": {
        if (noflag) {
          // NF 练习局：live 侧右键被禁（纯抖动），不切旗；计一次 wasted 右键
          if (!lp) {
            clRight++;
            wastedRight++;
          }
        } else if (!lp) {
          // flop rightPress：lp 按住时仅视觉（1.5 击里尾随 lc 的 rc 不插旗）；否则按下即刻 toggleLabel
          if (inside && toggleLabel(i, marks)) {
            clRight++;
            rv = false;
          } else {
            rv = true;
          }
        }
        rp = true;
        break;
      }
      case "rr": {
        // flop rightRelease：lp 按住时＝双击（松开坐标）；否则 rv 挂起补记一次 wasted 右键
        if (lp) {
          clDouble++;
          if (!openAroundIdx(inside ? i : -1)) wastedDouble++;
        } else if (rv) {
          clRight++;
          wastedRight++;
        }
        rp = lv = rv = sv = false; // 不动 lp（flop 原样）
        break;
      }
      case "mc":
        // mp = true（flop 中键按住仅视觉，计数在 mr；状态位不影响任何分支，无需维护）
        break;
      case "mr": {
        // flop middleRelease：无条件双击
        clDouble++;
        if (!openAroundIdx(inside ? i : -1)) wastedDouble++;
        break;
      }
      case "sc":
        // flop leftPressWithShift：chord 在其后的 lr 生效
        lp = lv = sv = true;
        break;
    }
    if (openedSafe >= safeTotal) over = true; // Win
    if (dead) over = true; // Blast → Lose
  }

  let flags = 0;
  for (let i = 0; i < N; i++) if (flagged[i]) flags++;
  /* 已完成 3BV（2026-10-30 张老师定：路线规划 bpp 分子用完成 3BV 而非总 3BV）：
     与站内 3BV 构件（VideoReplay buildBvStructures / 练习页 compute3BV）同法——
     0 格连通域 region（含边界数字格，归属唯一先到先得）全开算 1，其余非雷格
     （singles）开算 1。胜局天然 = 全盘 3BV，败局/未完成局只算真实开到的 */
  const region = new Int32Array(N).fill(-1);
  let regions = 0;
  const nbList = (c: number): number[] => {
    const x = c % W, y = (c / W) | 0;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        out.push(ny * W + nx);
      }
    }
    return out;
  };
  for (let i = 0; i < N; i++) {
    if (mines[i] || nums[i] !== 0 || region[i] !== -1) continue;
    const stack = [i];
    region[i] = regions;
    while (stack.length) {
      const c = stack.pop()!;
      for (const a of nbList(c)) {
        if (mines[a] || region[a] === regions) continue;
        region[a] = regions;
        if (nums[a] === 0) stack.push(a);
      }
    }
    regions++;
  }
  let solvedBv = 0;
  for (let r = 0; r < regions; r++) {
    let ok = true;
    for (let c = 0; c < N; c++) {
      if (region[c] !== r) continue;
      if (state[c] !== 1) { ok = false; break; }
    }
    if (ok) solvedBv++;
  }
  for (let c = 0; c < N; c++) {
    if (mines[c] || region[c] >= 0) continue;
    if (state[c] === 1) solvedBv++;
  }
  const cl = clLeft + clRight + clDouble;
  const ce = cl - (wastedLeft + wastedRight + wastedDouble);
  return {
    width: W,
    height: H,
    mines: board.mines,
    clLeft,
    clRight,
    clDouble,
    ce,
    wastedLeft,
    wastedRight,
    wastedDouble,
    unflag,
    pathPx,
    crossings,
    flags,
    flagged,
    solvedBv,
  };
}

/* ---- 结算数据面板行定义（2026-11-08 统一）--------------------------------
 * 练习页 OnlinePlay.statsReport 与录像页 VideoReplay.ReplayStatsTable 此前各写
 * 一份 rows，纯靠注释互标「同款」维持同步，已现漂移（Path 一边格数一边像素）。
 * 现统一为本共享件：行集/口径/气泡文案唯一来源，两侧只喂原始计数。
 * 派生值（Cl/est/qg/stnb）在本函数内统一计算——公式与 flop counters 逐项对齐
 * （Est=RT×(3BV/solved)；IOE=solved/Cl；ThrP=solved/Ce；Corr=Ce/Cl；
 * RQP=Est×(Est+1)/3BV；QG=RT^1.7/solved；
 * STNB=(73.5L²−94.5L+57)/QG×(solved/3BV)^0.5，QG/STNB 用 Est RTime 代入——
 * 2026-10-30 张老师定败局修正，胜局 est=t 恒等旧值；
 * Est STNB=(73.5L²−94.5L+57)÷(Est^1.7/3BV)，整盘等效不打完成度折扣——
 * 2026-11-09 张老师定：未完成局（solved<3BV）在 STNB 行下追加，完整局不显示
 * （录像页全是完整局，该行天然不出现）；
 * RTime 后缀 (n)=floor(RT)+1 录像秒数口径）。
 * Path 展示口径全站统一为**格数**（16px/格折算）单行——与 ppc「格/次」单位一致、
 * 与盘面尺寸无关（2026-11-09 张老师定：不要 CPath——现在没有用到，单行即格数）。
 * 仍须零依赖：练习页在客户端引用。 */
export interface StatsRowSource {
  /** 实际用时（秒） */
  t: number;
  board3bv: number;
  solvedBv: number;
  solvedOps: number;
  totalOps: number;
  solvedIsls: number;
  totalIsls: number;
  clLeft: number;
  clRight: number;
  clDouble: number;
  /** 有效点击（Ce = Cl − wasted，两侧各自来自重放引擎/对局计数） */
  ce: number;
  /** 鼠标行程（棋盘 1x 像素，Path 行按 16px/格折算成格数展示） */
  pathPx: number;
  /** 跨格次数（0.5px 光栅化口径） */
  crossings: number;
  /** 玩家实际插旗数（胜局自动补旗不含） */
  flags: number;
  /** STNB 难度档：标准级别 beg=1/int=2/exp=3；自定义盘按雷密度折算后传入 */
  ln: number;
}

export function statsRows(s: StatsRowSource): [string, string, string][] {
  const f3 = (v: number) => v.toFixed(3);
  const cl = s.clLeft + s.clRight + s.clDouble;
  const hasBv = s.solvedBv > 0 && s.t > 0;
  const est = hasBv ? s.t * (s.board3bv / s.solvedBv) : 0;
  const qg = hasBv ? Math.pow(est, 1.7) / s.solvedBv : 0;
  const cc = 73.5 * s.ln * s.ln - 94.5 * s.ln + 57;
  const stnb = hasBv ? (cc / qg) * Math.sqrt(s.solvedBv / s.board3bv) : 0;
  /* 整盘等效 STNB（2026-11-09 张老师定）：完成度按 1 代入（不打 p^1.5 折扣），
     仅未完成局显示——胜局两者相等，录像页全是完整局故该行天然不出现 */
  const unfinished = hasBv && s.solvedBv < s.board3bv;
  const estStnb = unfinished ? (cc / Math.pow(est, 1.7)) * s.board3bv : 0;
  const freq = (n: number) => (s.t > 0 ? f3(n / s.t) : "0.000");
  return [
    ["RTime", f3(s.t) + " (" + (Math.floor(s.t) + 1) + ")", "本局实际用时（秒），括号内为按秒进位的录像计分时间"],
    ["Est RTime", hasBv ? f3(est) + " (" + (Math.floor(est) + 1) + ")" : "* (*)", "按完成度折算的估算用时 = 实际用时 × 3BV ÷ 已完成 3BV"],
    ["3BV", s.solvedBv + "/" + s.board3bv, "盘面理论最少点击次数（Bechtel 基准值），显示为 已完成 / 全盘总量"],
    ["3BV/s", hasBv ? f3(s.solvedBv / s.t) : "*", "每秒完成的 3BV 数 = 已完成 3BV ÷ 实际用时，衡量操作效率"],
    ["Ops", s.solvedOps + "/" + s.totalOps, "开空区域（opening）的完成数 / 全盘总数"],
    ["Isls", s.solvedIsls + "/" + s.totalIsls, "孤立数字块（island）的完成数 / 全盘总数"],
    ["Left", s.clLeft + "@" + freq(s.clLeft), "左键点击次数 @ 每秒点击频率"],
    ["Right", s.clRight + "@" + freq(s.clRight), "右键点击次数 @ 每秒点击频率"],
    ["Double", s.clDouble + "@" + freq(s.clDouble), "双击（左右同按/中键/单击数字/速旗等 chord 手势）次数 @ 每秒频率"],
    ["Ce", s.ce + "@" + freq(s.ce), "有效点击次数（真正开出新格或完成 3BV 的点击）@ 每秒频率"],
    ["Cl", cl + "@" + freq(cl), "总点击次数（左键 + 右键 + 双击）@ 每秒频率"],
    ["IOE", cl > 0 ? f3(s.solvedBv / cl) : "*", "效率指数 = 已完成 3BV ÷ 总点击次数"],
    ["ThrP", s.ce > 0 ? f3(s.solvedBv / s.ce) : "*", "吞吐效率 = 已完成 3BV ÷ 有效点击次数"],
    ["Corr", cl > 0 ? f3(s.ce / cl) : "*", "准确率 = 有效点击 ÷ 总点击次数"],
    ["Path", String(Math.round(s.pathPx / 16)), "鼠标移动路径总长（按 16px/格折算的格数，全站统一口径）"],
    ["Crossings", String(s.crossings), "鼠标轨迹跨过格线的次数（跨格计数，路线规划「完成3BV/Crossings」的分母；对鼠标回报率免疫）"],
    ["Flags", String(s.flags), "玩家实际插旗数量（胜利时自动补的旗不计）"],
    ["RQP", hasBv ? f3((est * (est + 1)) / s.board3bv) : "*", "性价比 = 估算用时 × (估算用时 + 1) ÷ 3BV"],
    ["QG", hasBv ? f3(qg) : "*", "质量分 = 估算用时 ^ 1.7 ÷ 已完成 3BV（估算用时 = 实际用时 × 3BV ÷ 已完成 3BV，胜局两者相等）"],
    ["STNB", hasBv ? f3(stnb) : "*", "综合评分（按难度与完成度归一化，越大越好；自定义盘按雷密度折算难度）"],
    ...(unfinished
      ? ([["Est STNB", f3(estStnb), "整盘等效综合评分 = 假设按 Est RTime 完成全盘 3BV 的 STNB（上方 STNB 行带完成度折扣，本行不打折，可与录像页完整局直接对比；完整局两者相等故不显示）"]] as [string, string, string][])
      : []),
  ];
}
