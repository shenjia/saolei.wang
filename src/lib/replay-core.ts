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
  /** 终盘插旗数 */
  flags: number;
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
      if (lastX !== null && lastY !== null) pathPx += Math.hypot(e.px - lastX, e.py - lastY);
      lastX = e.px;
      lastY = e.py;
    } else {
      lastX = null;
      lastY = null;
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
    flags,
  };
}
