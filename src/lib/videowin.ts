// 录像完整度判定：flop 引擎语义 1:1 移植（2026-10-16 四轮修正）
//
// 权威依据＝flop 官方引擎源码逐字移植（app~b07b7304.8c5b5bcd.js 模块 5fd3 VideoParser），
// 并已在 Node 中原真运行该 webpack 模块作为 gold standard 逐事件对照（26 判例 + 20 抽样全对齐）。
// 此前三轮及以前的「3x3 邻域 chord / 孤 lr＝首击 / 尾部 lc 补记」均为对 flop 的错误补偿
// （337484 误杀、335360/335652 及 20 个抽样「假败局」皆由补丁制造），本轮全部移除。
//
// flop 语义（与源码一一对应）：
//   lc → leftPressed=leftValid=true（无游戏效果，视觉按压）；
//   lr → 右键/shift 按住时＝chord（单格：仅光标下那格 opened 且 数字=0或=周围旗数 才开 3x3），
//        否则 leftValid 时以松开坐标开单格；复位 lp/lv/rv/sv（不动 rp）；
//   rc → 左键按住时仅视觉按压（不插旗！）；否则 toggleLabel（旗→问号/摘旗，问号/未标→插旗）；
//   rr → 左键按住时＝chord（单格，同上）；复位 rp/lv/rv/sv（不动 lp）；
//   mc → 仅视觉；mr → 单格 chord；sc → leftPressed/shiftValid 置位（chord 在其后的 lr 生效）；
//   mt → 切换问号开关（toggleLabel 的旗→问号分支依赖 marks）；
//   开格：opened/flagged 跳过，questioned 可开，0 号泛洪，踩雷 Blast；
//   胜利＝全部安全格开启（与 flop solvedBBBV===mBBBV 等价）；无任何事件＝Begin→incomplete。
// 用途：上传校验（只有完整胜局可上传——2026-10-15 张老师要求，堵 AVF 败局漏网）。

export type VideoOutcome = "win" | "loss" | "incomplete";

export function judgeVideoOutcome(v: {
  width: number;
  height: number;
  board: string;
  events: string[];
  /** 问号开关（RawVF 头 QuestionMarks/Marks 行）；缺省 off */
  marks?: boolean;
}): VideoOutcome {
  const rows = v.height;
  const cols = v.width;
  const N = rows * cols;
  if (!rows || !cols || v.board.length !== N) return "incomplete";
  const mines = new Uint8Array(N);
  const nums = new Uint8Array(N);
  let safeCount = 0;
  for (let i = 0; i < N; i++) {
    const ch = v.board[i];
    if (ch === "*") mines[i] = 1;
    else {
      nums[i] = ch.charCodeAt(0) - 48;
      safeCount++;
    }
  }
  const evs: { ev: string; px: number; py: number }[] = [];
  for (const line of v.events) {
    // 时间戳可为负（evf 负值修正：开局前按下/标旗在计时起点之前），此处不消费时间
    const m = /^(-?[\d.]+) (lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (m) evs.push({ ev: m[2], px: +m[5], py: +m[6] });
  }
  if (!evs.length) return "incomplete"; // flop：无事件 gameState 停在 Begin

  const inside = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const opened = new Uint8Array(N);
  const flagged = new Uint8Array(N);
  const questioned = new Uint8Array(N);
  let dead = false;
  let openedCount = 0;
  let marks = v.marks ?? false;

  const flagsAround = (c: number, r: number) => {
    let n = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if (inside(c + dc, r + dr) && flagged[(r + dr) * cols + c + dc]) n++;
    return n;
  };

  /** flop open()：开单格（0 号递归 chord 泛洪）；返回是否开格 */
  const open = (c: number, r: number): boolean => {
    if (!inside(c, r)) return false;
    const i = r * cols + c;
    if (opened[i] || flagged[i]) return false;
    opened[i] = 1;
    openedCount++;
    if (mines[i]) {
      dead = true; // Blast
      return true;
    }
    if (nums[i] === 0) openAround(c, r); // 0 号泛洪（flop: 0===number && openAround）
    return true;
  };

  /** flop openAround()：单格 chord——仅光标下那格 opened 且满足旗数时开 3x3 邻域 */
  const openAround = (c: number, r: number): boolean => {
    if (!inside(c, r)) return false;
    const i = r * cols + c;
    if (!opened[i] || !(nums[i] === 0 || nums[i] === flagsAround(c, r))) return false;
    let any = false;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) any = open(c + dc, r + dr) || any;
    return any;
  };

  /** flop toggleLabel()：旗→问号(marks)/摘旗、问号→清除、未标→插旗；返回是否可操作 */
  const toggleLabel = (c: number, r: number): boolean => {
    if (!inside(c, r)) return false;
    const i = r * cols + c;
    if (opened[i]) return false;
    if (marks && flagged[i]) {
      flagged[i] = 0;
      questioned[i] = 1;
    } else if (flagged[i]) {
      flagged[i] = 0;
      questioned[i] = 0;
    } else if (questioned[i]) {
      flagged[i] = 0;
      questioned[i] = 0;
    } else {
      flagged[i] = 1;
      questioned[i] = 0;
    }
    return true;
  };

  /* flop 状态机：lp/lv/rp/rv/mp/sv + marks（mt 切换） */
  let lp = false,
    lv = false,
    rp = false,
    rv = false,
    sv = false;
  for (const e of evs) {
    if (dead) break;
    if (openedCount === safeCount) break; // Win：后续事件无效（flop performEvent 守卫）
    const col = (e.px / 16) | 0;
    const row = (e.py / 16) | 0;
    switch (e.ev) {
      case "lc":
        lp = lv = true;
        break;
      case "lr":
        if (rp || sv) openAround(col, row);
        else if (lv) open(col, row);
        lp = lv = rv = sv = false; // 不动 rp（flop 原样）
        break;
      case "rc":
        if (!lp) {
          if (toggleLabel(col, row)) rv = false;
          else rv = true;
        } // lp 时仅 pressAround 视觉，不插旗
        rp = true;
        break;
      case "rr":
        if (lp) openAround(col, row);
        rp = lv = rv = sv = false; // 不动 lp（flop 原样）
        break;
      case "mc":
        // mp = true（仅视觉）
        break;
      case "mr":
        openAround(col, row);
        // mp = false
        break;
      case "sc":
        lp = lv = sv = true; // chord 在其后的 lr 生效
        break;
      case "mt":
        marks = !marks;
        break;
    }
  }
  if (dead) return "loss";
  return openedCount === safeCount ? "win" : "incomplete";
}
