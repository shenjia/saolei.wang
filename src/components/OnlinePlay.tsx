"use client";

// 在线玩（一期：纯前端娱乐局，不存录像、成绩不入排行）
// 引擎为自有实现（布雷 / 首击 3×3 保护 / flood 展开 / chord / 标准 3BV / 0.01s 计时），
// 行为经 design/online-play.html 多轮 playwright 自验；外观复刻 flop player 经典银灰。
// 二期预留：JS 端编码标准 AVF → 走现有上传/审核管线上榜。

import { useEffect, useRef } from "react";
import { FlopSprites } from "./FlopSprites";

export function OnlinePlay() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const container: HTMLDivElement = root; // 函数声明内闭包丢失空值收窄，取非空别名
    const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
      root.querySelector<T>("#" + id)!;
    const ac = new AbortController();
    const signal = ac.signal;
    const on = <E extends Event>(
      el: HTMLElement | Document,
      type: string,
      fn: (e: E) => void,
      opts?: AddEventListenerOptions,
    ) => el.addEventListener(type, fn as EventListener, { ...opts, signal });

    /* 级别口径与站内排行一致（lib/config.ts：beg 8×8，2026-10-14 张老师指正） */
    const LEVELS: Record<string, { x: number; y: number; m: number }> = {
      beg: { x: 8, y: 8, m: 10 },
      int: { x: 16, y: 16, m: 40 },
      exp: { x: 30, y: 16, m: 99 },
    };
    let lv = "beg", W = 8, H = 8, M = 10;
    /* NF / 无猜为独立开关（可叠加，2026-10-14 张老师定）；全屏开关只控制显示、不影响对局；
       问号开关（默认关）只影响右键循环是否经过问号态，切换不重开 */
    let nf = false, ng = false, qmark = false;
    let mines: Uint8Array | null = null, nums: Uint8Array | null = null;
    let state: Uint8Array = new Uint8Array(0); // 0=block 1=open 2=flag 3=question
    let started = false, over = false, startTs = 0, timerId: number | null = null;
    let openedSafe = 0, totalSafe = 0, board3bv = 0;
    let pressCell: number | null = null, chordCells: number[] | null = null, bothButtons = false;
    /* ---- 对局统计（结算报告用，口径与 flop player counters 一致，公式见其打包源码注释） ---- */
    let flagToggles = 0; // 插旗状态变化次数（配合 openedSafe 判断点击是否有效 Ce）
    let stLeft = 0, stRight = 0, stDouble = 0, stCe = 0, stPath = 0;
    let lastPX: number | null = null, lastPY = 0;
    let bvRegions: number[][] = []; // 空格连通域（含边界数字格）
    let bvSingles: number[] = []; // 非空格区的数字格（3BV 单击格）
    let bvIslands: number[][] = []; // singles 的八连连通域（岛屿）
    /* 计一次点击并按「棋盘是否有变化」累计有效点击 Ce（=Cl-浪费点击，flop 口径） */
    function action(kind: "left" | "right" | "double", fn: () => void) {
      const s0 = openedSafe * 1024 + flagToggles;
      if (kind === "left") stLeft++; else if (kind === "right") stRight++; else stDouble++;
      fn();
      if (openedSafe * 1024 + flagToggles !== s0) stCe++;
    }

    const tbody = $("gtbody") as unknown as HTMLTableSectionElement;
    const ledMines = $("led_mines") as unknown as SVGElement;
    const ledTime = $("led_time") as unknown as SVGElement;
    const faceUse = $("face_use") as unknown as SVGUseElement;
    let faceKind = "smile"; // 当前笑脸状态（press 为瞬时按下态，不记）
    const FACE_MAP: Record<string, string> = {
      smile: "face-normal", ooh: "face-press-cell", dead: "face-lose",
      win: "face-win", press: "face-press-normal",
    };
    const flagBtn = $("flagmode_btn");
    const gname = $("gname");
    const greport = $("greport");
    let flagMode = false;

    function idx(x: number, y: number) { return y * W + x; }
    function inBoard(x: number, y: number) { return x >= 0 && x < W && y >= 0 && y < H; }
    function neighbors(i: number): number[] {
      const x = i % W, y = (i / W) | 0, r: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (inBoard(nx, ny)) r.push(idx(nx, ny));
      }
      return r;
    }
    /* LED 数码管：与 flop SkinCounterTop 同规则——负数时百位显负号、只显两位，范围 -99~999 */
    function led(el: SVGElement, v: number) {
      v = Math.max(-99, Math.min(999, Math.round(v)));
      const a = Math.abs(v);
      const ds: (string | number)[] = v < 0
        ? ["minus", ((a / 10) | 0) % 10, a % 10]
        : [((a / 100) | 0) % 10, ((a / 10) | 0) % 10, a % 10];
      const uses = el.querySelectorAll("use.d");
      for (let k = 0; k < 3; k++) uses[k].setAttribute("href", "#count-" + ds[k]);
    }
    function setFace(kind: string) {
      if (kind !== "press") faceKind = kind;
      faceUse.setAttribute("href", "#" + FACE_MAP[kind]);
    }
    function cellTd(i: number) { return tbody.rows[(i / W) | 0].cells[i % W]; }
    /* ---- 双渲染管线（2026-10-14 张老师定）----
       小倍率（<1.5x）：legacy 位图精灵（td 背景图，模糊插值——像素图放大必然糊，
       pixelated 锯齿方案已被否决回退）。
       大倍率（≥1.5x，含全屏拉满/横屏顶满）：flop 矢量贴图，无限放大边缘平滑。
       VEC_MAP 把引擎态类名映射到 symbol id。 */
    let useVector = false;
    const VEC_MAP: Record<string, string> = {
      bb: "cell-normal", bf: "cell-flag", bq: "cell-question",
      b0: "cell-number-0", b1: "cell-number-1", b2: "cell-number-2", b3: "cell-number-3",
      b4: "cell-number-4", b5: "cell-number-5", b6: "cell-number-6", b7: "cell-number-7",
      b8: "cell-number-8", bm: "cell-mine", bn: "cell-flag-wrong",
    };
    /* 整盘单 SVG 渲染面（2026-10-14 二次返工，治「像素级错位」）：
       上一版每格各自内嵌 <svg>，分数倍率下各格落在不同亚像素相位（zoom2.1 实测格宽
       33.594px、格坐标 .625/.219/.813…），每格独立光栅化 → 格缘反锯齿深浅不一＝错位。
       flop 原版同构方案：整盘一张 <svg> 覆盖层，所有格子共用同一坐标系、一次光栅化，
       任意倍率网格完全均匀。table 只承担布局与命中（覆盖层 pointer-events:none）；
       td 语义类（bb/b1/bm…）恒保持——败局 bm/bn 补绘检测两种管线共用，不再置 "bv"。 */
    let vecUse: SVGUseElement[] = [];
    function buildVecBoard() {
      const cw = gboard.clientWidth, ch = gboard.clientHeight;
      if (!cw || !ch) return; // tbody 未建（init 时 savedZoom 先于 reset），reset 里会再建
      const svg = $("vec_board") as unknown as SVGSVGElement;
      svg.setAttribute("viewBox", "0 0 " + cw + " " + ch);
      svg.setAttribute("preserveAspectRatio", "none");
      /* 底铺一层 cell-normal 平铺 pattern（board 内容盒与 table 等大，正常被格子盖满，
         仅作尺寸舍入兜底）；每格一个 <use>，x/y 取 16 的整数倍 → 与 table 格严格对齐 */
      let s = '<defs><pattern id="vec_tile" width="16" height="16" patternUnits="userSpaceOnUse">'
        + '<use href="#cell-normal" width="16" height="16"/></pattern></defs>'
        + '<rect width="100%" height="100%" fill="url(#vec_tile)"/>';
      for (let i = 0; i < W * H; i++) {
        s += '<use href="#cell-normal" x="' + (i % W) * 16 + '" y="' + ((i / W) | 0) * 16 + '" width="16" height="16"/>';
      }
      svg.innerHTML = s;
      vecUse = Array.from(svg.querySelectorAll(":scope > use")) as SVGUseElement[];
    }
    function paintCell(td: HTMLTableCellElement, cls: string) {
      td.className = cls;
      td.innerHTML = "";
      if (useVector && vecUse.length) {
        const i = (td.parentElement as HTMLTableRowElement).rowIndex * W + td.cellIndex;
        const sym = VEC_MAP[cls];
        vecUse[i]?.setAttribute("href", sym ? "#" + sym : "");
      }
    }
    function paint(i: number) {
      const td = cellTd(i), s = state[i];
      if (s === 1) paintCell(td, "b" + nums![i]);
      else if (s === 2) paintCell(td, "bf");
      else if (s === 3) paintCell(td, "bq");
      else paintCell(td, "bb");
    }
    let hitIdx: number | null = null; // 敗局踩中格（红底炸弹），重开清空
    function paintBomb(i: number) {
      const td = cellTd(i);
      td.className = "";
      td.innerHTML = "";
      if (useVector) vecUse[i]?.setAttribute("href", "#cell-mine-bomb");
      /* 位图管线注入内嵌 svg（symbol 以 168 为基准坐标系，viewBox 必须一致，160 会放大 5% 错位） */
      else td.innerHTML = '<svg viewBox="0 0 168 168" width="16" height="16" style="display:block"><use href="#cell-mine-bomb"/></svg>';
    }
    /* 全盘重绘（渲染管线切换 / 重开） */
    function repaintAll() {
      for (let i = 0; i < state.length; i++) {
        const td = cellTd(i), s = state[i];
        let cls = "bb";
        if (s === 1) cls = over ? (mines![i] ? "bm" : "b" + nums![i]) : "b" + nums![i];
        else if (s === 2) cls = "bf";
        else if (s === 3) cls = "bq";
        /* 敗局雷区揭示：引擎只在 lose 时改 DOM 不改 state，这里按类名标记补齐
           （语义类恒在 td 上，矢量切换往返都不会丢） */
        if (over && s === 1 && td.classList.contains("bm")) cls = "bm";
        if (over && td.classList.contains("bn")) cls = "bn";
        paintCell(td, cls);
      }
      if (over && hitIdx !== null) paintBomb(hitIdx);
    }
    function flagsLeft() {
      let f = 0;
      for (let i = 0; i < state.length; i++) if (state[i] === 2) f++;
      return M - f;
    }
    function placeMines(first: number) {
      const n = W * H;
      let excl: Record<number, number> = { [first]: 1 };
      const nb = neighbors(first);
      if (n - 1 - nb.length >= M) {
        excl = { [first]: 1 };
        for (const c of nb) excl[c] = 1;
      }
      const cand: number[] = [];
      for (let i = 0; i < n; i++) if (!excl[i]) cand.push(i);
      mines = new Uint8Array(n); nums = new Uint8Array(n);
      for (let j = 0; j < M; j++) {
        const p = (Math.random() * (cand.length - j)) | 0;
        mines[cand[p]] = 1; cand[p] = cand[cand.length - 1 - j];
      }
      for (let c = 0; c < n; c++) {
        if (mines[c]) continue;
        const around = neighbors(c);
        let cnt = 0;
        for (const a of around) if (mines[a]) cnt++;
        nums[c] = cnt;
      }
      compute3BV();
    }
    function compute3BV() {
      const n = W * H, region = new Int32Array(n).fill(-1);
      let regions = 0;
      for (let i = 0; i < n; i++) {
        if (mines![i] || nums![i] !== 0 || region[i] !== -1) continue;
        const stack = [i];
        region[i] = regions;
        while (stack.length) {
          const c = stack.pop()!, around = neighbors(c);
          for (const a of around) {
            if (mines![a] || region[a] === regions) continue;
            region[a] = regions;
            if (nums![a] === 0) stack.push(a);
          }
        }
        regions++;
      }
      /* 结算报告用：按 region 标签收集空格域格子（含边界数字），其余非雷格为 singles，
         singles 再做八连连通域 = 岛屿（Isls） */
      bvRegions = Array.from({ length: regions }, () => []);
      bvSingles = [];
      for (let c = 0; c < n; c++) {
        if (mines![c]) continue;
        if (region[c] >= 0) bvRegions[region[c]].push(c);
        else bvSingles.push(c);
      }
      const singleSet = new Uint8Array(n), seen = new Uint8Array(n);
      for (const c of bvSingles) singleSet[c] = 1;
      bvIslands = [];
      for (const s of bvSingles) {
        if (seen[s]) continue;
        const isl: number[] = [], stack = [s];
        seen[s] = 1;
        while (stack.length) {
          const c = stack.pop()!;
          isl.push(c);
          for (const a of neighbors(c)) {
            if (singleSet[a] && !seen[a]) { seen[a] = 1; stack.push(a); }
          }
        }
        bvIslands.push(isl);
      }
      board3bv = regions + bvSingles.length;
    }
    function startTimer() {
      startTs = performance.now();
      timerId = window.setInterval(() => {
        led(ledTime, Math.floor((performance.now() - startTs) / 1000));
      }, 100);
    }
    function stopTimer() {
      if (timerId) { clearInterval(timerId); timerId = null; }
      return (performance.now() - startTs) / 1000;
    }
    /* ---- 无猜模式（ng）：踩到雷时，若存在与当前已揭示信息一致、且该格非雷的雷分布，
       则按该分布整局重排（该格变为安全）；若该格已被线索锁死为 100% 雷（不存在非雷解），
       才判定踩雷。语义=「只要存在不是雷的可能就救回来」（2026-10-14 张老师定）。
       追加规则（同日二轮）：盲点（周围没有任何已揭示数字的格）只要有可能就重排成
       opening——click 的 3×3 邻域全部非雷，点开即空域展开，就像开局首击一样；
       opening 无解时踩雷盲点退化为仅救回本格。
       实现：前沿格（已揭示数字的隐藏邻格）回溯求解，使每个已揭示数字的隐藏邻格雷数
       恰好等于其数值（已揭示数字因此保持不变）；其余雷随机撒入后方无关区。
       节点数设上限兜底，极端盘面超时按「无解=必中」处理（概率极低，娱乐局可接受）。 */
    function isBlind(i: number): boolean {
      /* 盲点=8 邻域内没有任何已揭示格（已揭示格必带数字；空格域的邻居早已被 flood 打开） */
      return !neighbors(i).some((a) => state[a] === 1);
    }
    function tryNoGuess(click: number, makeOpening: boolean): boolean {
      const n = W * H;
      const clues: { need: number; vars: number[] }[] = [];
      const inFrontier = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (state[i] !== 1 || nums![i] === 0) continue;
        const vars = neighbors(i).filter((a) => state[a] !== 1);
        if (!vars.length) continue;
        clues.push({ need: nums![i], vars });
        for (const v of vars) inFrontier[v] = 1;
      }
      const frontier: number[] = [];
      const varIndex = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        if (inFrontier[i]) { varIndex[i] = frontier.length; frontier.push(i); }
      }
      /* 保护区：opening 模式=click 及其 3×3 隐藏邻域全部非雷（同首击 3×3 保护）；
         普通救回仅保护 click 本身 */
      const protect = new Uint8Array(n);
      protect[click] = 1;
      if (makeOpening) {
        for (const a of neighbors(click)) if (state[a] !== 1) protect[a] = 1;
      }
      /* 后方区（与任何已揭示数字不相邻的隐藏格）排除保护区：落在保护区内天然非雷 */
      const back: number[] = [];
      for (let i = 0; i < n; i++) {
        if (state[i] !== 1 && !inFrontier[i] && !protect[i]) back.push(i);
      }
      const F = frontier.length;
      const varClues: number[][] = Array.from({ length: F }, () => []);
      clues.forEach((c, ci) => {
        for (const v of c.vars) varClues[varIndex[v]].push(ci);
      });
      const assign = new Int8Array(F).fill(-1);
      const needLeft = clues.map((c) => c.need);
      const freeLeft = clues.map((c) => c.vars.length);
      /* 保护区内若有前沿格则固定为非雷；任何一个被线索锁死（必须雷）则本次无解 */
      for (let i = 0; i < n; i++) {
        if (!protect[i] || varIndex[i] < 0) continue;
        const k = varIndex[i];
        assign[k] = 0;
        for (const ci of varClues[k]) freeLeft[ci]--;
        for (const ci of varClues[k]) if (needLeft[ci] > freeLeft[ci]) return false;
      }
      const order = Array.from({ length: F }, (_, k) => k)
        .filter((k) => assign[k] === -1)
        .sort((a, b) => varClues[b].length - varClues[a].length);
      let nodes = 0;
      function backFeasible(): boolean {
        let fMines = 0;
        for (let k = 0; k < F; k++) if (assign[k] === 1) fMines++;
        const needBack = M - fMines;
        return needBack >= 0 && needBack <= back.length;
      }
      function dfs(t: number): boolean {
        if (t === order.length) return backFeasible();
        if (++nodes > 1000000) return false;
        const k = order[t];
        const vals = Math.random() < 0.5 ? [0, 1] : [1, 0];
        for (const v of vals) {
          let ok = true;
          for (const ci of varClues[k]) {
            const nl = needLeft[ci] - v, fl = freeLeft[ci] - 1;
            if (nl < 0 || nl > fl) { ok = false; break; }
          }
          if (!ok) continue;
          assign[k] = v;
          for (const ci of varClues[k]) { needLeft[ci] -= v; freeLeft[ci]--; }
          if (dfs(t + 1)) return true;
          for (const ci of varClues[k]) { needLeft[ci] += v; freeLeft[ci]++; }
          assign[k] = -1;
        }
        return false;
      }
      if (!dfs(0)) return false;
      /* 应用新雷分布：前沿按解、后方随机补齐，数字与 3BV 全量重算 */
      const newMines = new Uint8Array(n);
      frontier.forEach((cell, k) => { if (assign[k] === 1) newMines[cell] = 1; });
      let fMines = 0;
      for (let k = 0; k < F; k++) if (assign[k] === 1) fMines++;
      const needBack = M - fMines;
      for (let j = 0; j < needBack; j++) {
        const p = (Math.random() * (back.length - j)) | 0;
        newMines[back[p]] = 1;
        back[p] = back[back.length - 1 - j];
      }
      mines = newMines;
      const nn = new Uint8Array(n);
      for (let c = 0; c < n; c++) {
        if (mines[c]) continue;
        let cnt = 0;
        for (const a of neighbors(c)) if (mines[a]) cnt++;
        nn[c] = cnt;
      }
      nums = nn;
      compute3BV();
      return true;
    }
    function openCell(i: number) {
      if (over || state[i] === 1 || state[i] === 2) return;
      if (!started) { started = true; placeMines(i); startTimer(); }
      if (mines![i]) {
        /* 盲点踩雷：优先重排成 opening（3×3 全非雷，点开即空域，如同开局）；
           opening 无解再退化为仅救回本格；都无解才判负。
           重排不弹任何提醒（2026-10-14 张老师定：笑脸/盘面状态已够） */
        const saved = ng && ((isBlind(i) && tryNoGuess(i, true)) || tryNoGuess(i, false));
        if (!saved) { lose(i); return; }
      } else if (ng && nums![i] !== 0 && isBlind(i)) {
        tryNoGuess(i, true); // 安全盲点（数字格）：同样尽量换成 opening，盲点必开空
      }
      const stack = [i];
      while (stack.length) {
        const c = stack.pop()!;
        if (state[c] === 1 || state[c] === 2 || mines![c]) continue;
        state[c] = 1; openedSafe++; paint(c);
        if (nums![c] === 0) {
          for (const a of neighbors(c)) if (state[a] === 0) stack.push(a);
        }
      }
      checkWin();
    }
    function chord(i: number) {
      if (over || state[i] !== 1 || nums![i] === 0) return;
      const around = neighbors(i);
      let f = 0;
      for (const a of around) if (state[a] === 2) f++;
      if (f !== nums![i]) return;
      for (const a of around) {
        if (state[a] === 0) { openCell(a); if (over) return; }
      }
    }
    function toggleFlag(i: number) {
      if (over) return;
      if (state[i] === 1) return;
      if (nf) return;
      /* 问号开关关：空白 ↔ 标雷 两态；开：空白 → 标雷 → 问号 三态循环 */
      if (state[i] === 0) state[i] = 2;
      else if (state[i] === 2) state[i] = qmark ? 3 : 0;
      else state[i] = 0;
      flagToggles++;
      paint(i);
      led(ledMines, flagsLeft());
    }
    /* ---- 结算报告（2026-10-14 张老师定：游戏结束时桌面版左侧浮窗，再开局隐藏）。
       公式与 flop player counters 逐项对齐（摘自其打包源码注释）：
       Est=RT×(3BV/solved)；IOE=solved/Cl；ThrP=solved/Ce；Corr=Ce/Cl；
       RQP=Est×(Est+1)/3BV；QG=RT^1.7/solved；
       STNB=(87.420L²−155.829L+115.708)/QG×(solved/3BV)^0.5（L: beg=1/int=2/exp=3）；
       RTime 后缀 (n)=floor(RT)+1（录像秒数口径） */
    function report(t: number) {
      let solvedBv = 0, solvedOps = 0;
      for (const reg of bvRegions) {
        let ok = true;
        for (const c of reg) if (state[c] !== 1) { ok = false; break; }
        if (ok) { solvedBv++; solvedOps++; }
      }
      for (const c of bvSingles) if (state[c] === 1) solvedBv++;
      let solvedIsls = 0;
      for (const isl of bvIslands) {
        let ok = true;
        for (const c of isl) if (state[c] !== 1) { ok = false; break; }
        if (ok) solvedIsls++;
      }
      const cl = stLeft + stRight + stDouble, ce = stCe;
      const f3 = (v: number) => v.toFixed(3);
      const hasBv = solvedBv > 0 && t > 0;
      const est = hasBv ? t * (board3bv / solvedBv) : 0;
      const qg = hasBv ? Math.pow(t, 1.7) / solvedBv : 0;
      const ln = lv === "beg" ? 1 : lv === "int" ? 2 : 3;
      const stnb = hasBv
        ? (87.420 * ln * ln - 155.829 * ln + 115.708) / qg * Math.sqrt(solvedBv / board3bv)
        : 0;
      /* 玩家实际插的旗数（胜利结算前会先抓这个值，自动补旗不算） */
      const playerFlags = M - flagsLeft();
      const rows: [string, string][] = [
        ["RTime", f3(t) + " (" + (Math.floor(t) + 1) + ")"],
        ["Est RTime", hasBv ? f3(est) + " (" + (Math.floor(est) + 1) + ")" : "* (*)"],
        ["3BV", solvedBv + "/" + board3bv],
        ["3BV/s", hasBv ? f3(solvedBv / t) : "*"],
        ["Ops", solvedOps + "/" + bvRegions.length],
        ["Isls", solvedIsls + "/" + bvIslands.length],
        ["Left", stLeft + "@" + (t > 0 ? f3(stLeft / t) : "0.000")],
        ["Right", stRight + "@" + (t > 0 ? f3(stRight / t) : "0.000")],
        ["Double", stDouble + "@" + (t > 0 ? f3(stDouble / t) : "0.000")],
        ["Ce", ce + "@" + (t > 0 ? f3(ce / t) : "0.000")],
        ["Cl", cl + "@" + (t > 0 ? f3(cl / t) : "0.000")],
        ["IOE", cl > 0 ? f3(solvedBv / cl) : "*"],
        ["ThrP", ce > 0 ? f3(solvedBv / ce) : "*"],
        ["Corr", cl > 0 ? f3(ce / cl) : "*"],
        ["Path", String(Math.round(stPath))],
        ["Flags", String(playerFlags)],
        ["RQP", hasBv ? f3((est * (est + 1)) / board3bv) : "*"],
        ["QG", hasBv ? f3(qg) : "*"],
        ["STNB", hasBv ? f3(stnb) : "*"],
      ];
      greport.innerHTML =
        '<div class="gr_title">数据统计</div>' +
        "<table>" +
        rows.map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("") +
        "</table>";
      greport.classList.add("show");
    }
    function lose(hit: number) {
      over = true;
      const t = stopTimer();
      report(t); // 雷区揭示不影响统计（区域/单子只含非雷格，旗帜格不动）
      for (let i = 0; i < mines!.length; i++) {
        if (mines![i] && state[i] !== 2) { state[i] = 1; paintCell(cellTd(i), "bm"); }
        if (!mines![i] && state[i] === 2) paintCell(cellTd(i), "bn");
      }
      /* 炸掉的那颗雷：flop 原版红底标志（cell-mine-bomb），站内精灵图 bc 不是红底 */
      hitIdx = hit;
      paintBomb(hit);
      setFace("dead");
      /* 踩雷不再有任何文字提醒（张老师定：笑脸状态已经够了） */
    }
    function checkWin() {
      if (openedSafe !== totalSafe) return;
      over = true;
      const t = stopTimer();
      report(t); // 须在自动补旗之前：Flags 只算玩家实际插的
      for (let i = 0; i < mines!.length; i++) if (mines![i] && state[i] !== 2) { state[i] = 2; paint(i); }
      led(ledMines, 0);
      setFace("win");
      /* 胜利同样不再有任何文字提醒（数据都在左侧报告浮窗里） */
    }
    function reset(level?: string) {
      lv = level || lv;
      const L = LEVELS[lv]; W = L.x; H = L.y; M = L.m;
      mines = null; nums = null; state = new Uint8Array(W * H);
      started = false; over = false; openedSafe = 0; totalSafe = W * H - M; board3bv = 0;
      /* 统计清零 + 隐藏结算报告（张老师：游戏再次开始时隐藏） */
      flagToggles = 0; stLeft = 0; stRight = 0; stDouble = 0; stCe = 0; stPath = 0; lastPX = null;
      greport.classList.remove("show");
      stopTimer();
      led(ledMines, M); led(ledTime, 0);
      setFace("smile");
      const names: Record<string, string> = {
        beg: "初级 8×8 · 10 雷", int: "中级 16×16 · 40 雷", exp: "高级 30×16 · 99 雷",
      };
      gname.textContent = names[lv];
      let html = "";
      for (let y = 0; y < H; y++) {
        html += "<tr>";
        for (let x = 0; x < W; x++) html += '<td class="bb"></td>';
        html += "</tr>";
      }
      tbody.innerHTML = html;
      hitIdx = null;
      if (useVector) { buildVecBoard(); repaintAll(); } // 矢量覆盖层按新盘面尺寸重建
      /* 级别筛选器：激活项重建为 span.current，其余为 a（ranking_tabs 结构）；
         NF / 无猜开关是原生 checkbox，状态自持、跨局保持，无需重绘 */
      container.querySelectorAll("#level_tabs [data-lv]").forEach((el) => {
        const l = el.getAttribute("data-lv")!;
        el.outerHTML = l === lv
          ? '<span class="current" data-lv="' + l + '">' + el.textContent + "</span>"
          : '<a data-lv="' + l + '">' + el.textContent + "</a>";
      });
      /* NF 开启时触屏「插旗模式」按钮无意义，隐藏 */
      flagBtn.classList.toggle("hidden", nf);
      /* 全屏/横屏中切换级别或重开后，按新盘面尺寸重新拉满；普通模式刷新封顶
         （切到小盘后上限应回到 2.5，大盘则按容器宽收紧） */
      if (document.fullscreenElement === root) fitZoomForFullscreen();
      else if (lsQuery.matches) fitZoomForLandscape();
      else applyZoom(zoomCur, false);
    }

    on($("level_tabs"), "click", (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest("[data-lv]");
      if (t && t.getAttribute("data-lv") !== lv) reset(t.getAttribute("data-lv")!);
    });

    /* ---- 右上三开关：NF / 无猜 切换即重开一局；全屏只切显示 ---- */
    const swNf = $("sw_nf") as HTMLInputElement;
    const swNg = $("sw_ng") as HTMLInputElement;
    const swFs = $("sw_fs") as HTMLInputElement;
    on(swNf, "change", () => {
      nf = swNf.checked;
      if (nf && flagMode) flagBtn.click(); // 开 NF 前退出触屏插旗模式
      reset();
    });
    on(swNg, "change", () => {
      ng = swNg.checked;
      reset();
    });
    /* 问号开关只改右键循环行为，不打断当前对局（已有问号格仍可正常循环消掉） */
    const swQm = $("sw_qm") as HTMLInputElement;
    on(swQm, "change", () => { qmark = swQm.checked; });
    on(swFs, "change", () => {
      if (swFs.checked) {
        const p = root.requestFullscreen ? root.requestFullscreen() : null;
        if (p && p.catch) p.catch(() => { swFs.checked = false; }); // 被拒时回弹开关
      } else if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    });
    /* 全屏状态切换：进入时自动把游戏区比例拉满（记住原比例），
       退出（含 Esc）时恢复原比例并同步开关 */
    on(document, "fullscreenchange", () => {
      const entered = document.fullscreenElement === root;
      swFs.checked = entered;
      if (entered) {
        zoomBeforeFs = zoomCur;
        // 等全屏渲染稳定（innerWidth 更新为屏幕尺寸）后再测量计算
        window.setTimeout(() => { if (document.fullscreenElement === root) fitZoomForFullscreen(); }, 80);
      } else if (zoomBeforeFs !== null) {
        applyZoom(zoomBeforeFs, false);
        zoomBeforeFs = null;
        /* 退出全屏后仍在横屏自动模式：按视口高度重新拉满 */
        if (lsQuery.matches && zoomBeforeLs !== null) fitZoomForLandscape();
      }
    });
    /* 全屏中旋转屏幕等尺寸变化时重新拉满；横屏自动模式下浏览器栏显隐同理；
       普通模式下窗口变窄也重新封顶，避免游戏区冲出 #page 版块 */
    window.addEventListener("resize", () => {
      if (document.fullscreenElement === root) fitZoomForFullscreen();
      else if (lsQuery.matches && zoomBeforeLs !== null) fitZoomForLandscape();
      else applyZoom(zoomCur, false);
    }, { signal });

    const faceBtn = $("face_btn");
    on(faceBtn, "click", () => reset());
    on(faceBtn, "mousedown", () => setFace("press"));
    on(faceBtn, "mouseup", () => setFace(faceKind));
    on(faceBtn, "mouseleave", () => setFace(faceKind));

    /* ---- 鼠标交互：右键按下即插旗；左键抬起开格；左右同按在数字上 = 双击开周围 ---- */
    const gboard = $("gboard");
    on(gboard, "contextmenu", (e: Event) => e.preventDefault());
    function eventCell(e: { target: EventTarget | null }): number {
      const td = (e.target as HTMLElement).closest("td");
      if (!td || !tbody.contains(td)) return -1;
      return idx(td.cellIndex, (td.parentNode as HTMLTableRowElement).rowIndex);
    }
    function clearPress() {
      if (pressCell !== null && state.length && state[pressCell] === 0) paint(pressCell);
      pressCell = null;
      if (chordCells) {
        chordCells.forEach((c) => { if (state[c] === 0) paint(c); });
        chordCells = null;
      }
    }
    /* 单格按下态跟随：从旧格挪到 i 格（按下态两种管线统一用位图 b0——浅灰凸起，
       flop 矢量体系里没有独立「未开格按下」贴图，cell-press 是已开格底不适用） */
    function pressSingle(i: number) {
      if (pressCell === i) return;
      if (pressCell !== null && state[pressCell] === 0) paint(pressCell);
      pressCell = i;
      if (state[i] === 0) { cellTd(i).className = "b0"; cellTd(i).innerHTML = ""; }
    }
    /* 左右同按 3×3 按下态跟随：高亮挪到 i 格邻域 */
    function pressAround(i: number) {
      if (chordCells) chordCells.forEach((c) => { if (state[c] === 0) paint(c); });
      chordCells = neighbors(i).concat([i]).filter((c) => state[c] === 0);
      chordCells.forEach((c) => { cellTd(c).className = "b0"; cellTd(c).innerHTML = ""; });
    }
    on(gboard, "mousedown", (e: MouseEvent) => {
      if (over) return;
      const i = eventCell(e); if (i < 0) return;
      if (e.buttons === 3) { // 左右同按 = 双击
        bothButtons = true; clearPress();
        pressAround(i);
        setFace("ooh");
      } else if (e.button === 0) {
        bothButtons = false;
        pressSingle(i);
        setFace("ooh");
      } else if (e.button === 2) {
        setFace("ooh"); // 右键按下笑脸同样变
        action("right", () => toggleFlag(i));
      }
    });
    /* 按住滑动：按下态实时跟随鼠标经过的格子（出盘后再进盘按 e.buttons 自愈） */
    on(gboard, "mouseover", (e: MouseEvent) => {
      if (over) return;
      const i = eventCell(e); if (i < 0) return;
      if (e.buttons === 3) {
        if (pressCell !== null) { if (state[pressCell] === 0) paint(pressCell); pressCell = null; }
        bothButtons = true;
        pressAround(i);
        setFace("ooh");
      } else if (e.buttons === 1) {
        if (chordCells) { chordCells.forEach((c) => { if (state[c] === 0) paint(c); }); chordCells = null; }
        bothButtons = false;
        pressSingle(i);
        setFace("ooh");
      }
    });
    on(gboard, "mouseup", (e: MouseEvent) => {
      if (over) { clearPress(); return; }
      const i = eventCell(e); clearPress(); setFace("smile");
      if (i < 0) { bothButtons = false; return; }
      if (e.button === 0) {
        if (bothButtons) { bothButtons = false; action("double", () => chord(i)); }
        else if (state[i] === 1) action("left", () => chord(i)); // 单击已满足的数字同效
        else action("left", () => openCell(i));
      }
    });
    on(gboard, "mouseleave", () => { clearPress(); if (!over) setFace("smile"); lastPX = null; });
    /* Path：对局中鼠标在棋盘上的欧氏行程，归一化到 1x 棋盘像素（除以游戏倍率与页级缩放） */
    on(gboard, "mousemove", (e: MouseEvent) => {
      if (started && !over) {
        if (lastPX !== null) {
          stPath += Math.hypot(e.clientX - lastPX, e.clientY - lastPY) / (zoomCur * pageZoom());
        }
        lastPX = e.clientX; lastPY = e.clientY;
      }
    });

    /* ---- 触屏交互：点按开格 / 长按插旗 / 插旗模式 ---- */
    let touchTimer: number | null = null, touchCell = -1, longFired = false;
    on(gboard, "touchstart", (e: TouchEvent) => {
      const i = eventCell(e.touches[0]); if (i < 0 || over) return;
      touchCell = i; longFired = false;
      touchTimer = window.setTimeout(() => {
        longFired = true; action("right", () => toggleFlag(i));
        if (navigator.vibrate) navigator.vibrate(30);
      }, 350);
      e.preventDefault();
    }, { passive: false });
    on(gboard, "touchend", (e: TouchEvent) => {
      if (touchTimer) clearTimeout(touchTimer);
      if (touchCell >= 0 && !over && !longFired) {
        if (flagMode) action("right", () => toggleFlag(touchCell));
        else if (state[touchCell] === 1) action("left", () => chord(touchCell));
        else action("left", () => openCell(touchCell));
      }
      touchCell = -1;
      e.preventDefault();
    }, { passive: false });
    on(gboard, "touchmove", () => { if (touchTimer) clearTimeout(touchTimer); touchCell = -1; });
    on(flagBtn, "click", () => {
      flagMode = !flagMode;
      flagBtn.classList.toggle("on", flagMode);
      flagBtn.textContent = flagMode ? "插旗中…" : "插旗模式";
    });

    /* ---- 缩放控制条（复刻 flop player 1.00x 滑杆） ---- */
    const gframe = $("gframe");
    const zoomRange = $("zoom_range") as HTMLInputElement;
    const zoomVal = $("zoom_val");
    let zoomCur = 1; // 当前游戏倍率（不含整页窄屏缩放）
    const lsQuery = window.matchMedia("(orientation: landscape) and (max-height: 520px)"); // 横屏拉满断点（声明须在 applyZoom 之前，normalMaxZoom 会读它）
    let zoomBeforeFs: number | null = null; // 进全屏前的倍率；全屏中手动调过则置 null 不再恢复
    /* 普通模式倍率上限：游戏渲染宽不得超过 #game_area 内容宽，否则冲出 #page 版块。
       用 getBoundingClientRect 实测自校准：gfR.width = 基准宽 × zoomCur × 所有祖先
       zoom，gaR.width = 容器宽 × 同一祖先 zoom——比值里 zoom 全部抵消，任意页级
       缩放/窄屏断点下都成立。全屏/横屏由 fitZoom* 拉满（max=5），不走此封顶 */
    function normalMaxZoom() {
      if (document.fullscreenElement === root || lsQuery.matches) return 5;
      const gfR = gframe.getBoundingClientRect();
      const gaR = ($("game_area") as HTMLElement).getBoundingClientRect();
      if (gfR.width <= 0 || gaR.width <= 0) return 2.5;
      /* 下限 0.5（=滑杆 min）：窄窗连 1x 都放不下时按容器宽自动缩，保证不溢出 */
      return Math.max(0.5, Math.min(2.5, (zoomCur * (gaR.width - 16)) / gfR.width)); // 左右各留 8px
    }
    function applyZoom(v: number, persist = true, max?: number) {
      const cap = max ?? normalMaxZoom();
      v = Math.max(0.5, Math.min(cap, v));
      zoomRange.max = String(cap); // 滑杆行程同步封顶，拖杆手感与实际一致
      gframe.style.zoom = String(v);
      zoomCur = v;
      zoomRange.value = String(v);
      zoomVal.textContent = v.toFixed(2) + "x";
      if (persist) {
        try { localStorage.setItem("online_play_zoom", String(v)); } catch { /* 隐私模式 */ }
      }
      syncRenderMode();
    }
    /* 渲染管线切换阈值：≥1.5x 矢量（大尺寸平滑），<1.5x 位图（原版像素图）。
       横屏/全屏自动拉满常在 0.8-3.4x 之间游走，切换在 applyZoom 里统一驱动 */
    const VEC_THRESHOLD = 1.5;
    function syncRenderMode() {
      const want = zoomCur >= VEC_THRESHOLD;
      if (want !== useVector) {
        useVector = want;
        gboard.classList.toggle("vector", useVector);
        if (useVector) buildVecBoard();
        repaintAll();
      }
    }
    /* 整页窄屏缩放系数（globals.css 阶梯断点 body #page{zoom:0.65..0.94}，≤605px 生效）：
       屏幕渲染尺寸 = 基准尺寸 × 游戏倍率 × 页级系数，全屏拉满必须除以它反算 */
    const pageEl = root.closest("#page");
    function pageZoom() {
      if (!pageEl) return 1;
      const z = parseFloat(getComputedStyle(pageEl as HTMLElement).zoom);
      return z > 0 ? z : 1;
    }
    /* 全屏自动拉满（2026-10-14 张老师定，主要面向手机）：取宽/高两个方向较小的倍率。
       已验证的量纲事实（Chrome）：gframe.offsetWidth/Height 不含 zoom，即基准尺寸；
       getBoundingClientRect 是渲染尺寸（含游戏 zoom 与页级 zoom），
       标题行/缩放条等未跟随游戏缩放的部分用 rect 差值量（任何状态下都成立，
       不能用 root.scrollHeight——全屏时它会被视口高度撑大）。
       max 放到 5：手机上页级 0.65 会把游戏倍率缩回去，拉满常需 3+（不进 localStorage） */
    function fitZoomForFullscreen() {
      const pz = pageZoom();
      const baseW = gframe.offsetWidth;
      const baseH = gframe.offsetHeight;
      const headR = container.querySelector(".news_head")!.getBoundingClientRect();
      const gfR = gframe.getBoundingClientRect();
      const othersH = (gfR.top - headR.top) + ($("game_area").getBoundingClientRect().bottom - gfR.bottom);
      const availW = window.innerWidth - 24; // :fullscreen 左右 padding 12px
      const availH = window.innerHeight - 48 - othersH; // :fullscreen 上下 padding 24px
      applyZoom(Math.min(availW / baseW, availH / baseH) / pz, false, 5);
    }
    on(zoomRange, "input", () => {
      zoomBeforeFs = null; // 全屏中手动调比例 → 以手动为准，退出不再恢复
      zoomBeforeLs = null; // 横屏自动拉满同理
      applyZoom(parseFloat(zoomRange.value));
    });
    on($("zoom_reset"), "click", () => { zoomBeforeFs = null; zoomBeforeLs = null; applyZoom(1); });
    try {
      const savedZoom = parseFloat(localStorage.getItem("online_play_zoom") || "1");
      if (savedZoom > 0) applyZoom(savedZoom);
    } catch { /* 隐私模式 */ }

    /* ---- 移动端横屏自动拉满高度（2026-10-14 张老师定）：横屏且视口高 ≤520px 时，
       CSS 已把标题/筛选器/开关移到侧面竖排，这里把游戏按视口高度拉满（页面无需滚动）。
       量纲与 fitZoomForFullscreen 相同：rect 实测渲染尺寸（含游戏 zoom 与页级 zoom），
       倍率与渲染尺寸成线性；手动拖滑杆后以手动为准，退出横屏恢复进前倍率 */
    let zoomBeforeLs: number | null = null; // 进横屏前的倍率；横屏中手动调过则置 null 不再恢复
    function fitZoomForLandscape() {
      if (document.fullscreenElement === root) return; // 全屏拉满优先
      const gfR = gframe.getBoundingClientRect();
      if (gfR.height <= 0 || gfR.width <= 0) return;
      const gaR = ($("game_area") as HTMLElement).getBoundingClientRect();
      /* 高度：视口高 − game_area 顶端（站头）− 底部余量 − 比例条等未缩放部分（rect 差值法）；
         宽度：视口宽 − 侧面标题栏 − 间距与页面边距 */
      const othersH = gaR.height - gfR.height;
      const targetH = window.innerHeight - gaR.top - 8 - othersH;
      const headR = container.querySelector(".news_head")!.getBoundingClientRect();
      const targetW = window.innerWidth - headR.width - 48;
      applyZoom(Math.min(zoomCur * (targetH / gfR.height), zoomCur * (targetW / gfR.width)), false, 5);
    }
    function syncLandscape() {
      if (lsQuery.matches) {
        if (zoomBeforeLs === null) zoomBeforeLs = zoomCur;
        window.scrollTo(0, 0); // 顶满高度以页面顶为基准，先回顶再量
        window.setTimeout(fitZoomForLandscape, 60); // 等媒体查询布局生效后测量
      } else if (zoomBeforeLs !== null) {
        applyZoom(zoomBeforeLs, false);
        zoomBeforeLs = null;
      }
    }
    lsQuery.addEventListener("change", syncLandscape, { signal });

    on(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "F2" || e.key === "r" || e.key === "R") reset();
    });

    /* dev 环境测试钩子（生产构建不含）：供 playwright 读取内部状态验证无猜重排等逻辑 */
    const win = window as unknown as { __op?: Record<string, unknown> };
    if (process.env.NODE_ENV === "development") {
      win.__op = {
        mines: () => (mines ? Array.from(mines) : null),
        nums: () => (nums ? Array.from(nums) : null),
        state: () => Array.from(state),
        nf: () => nf,
        ng: () => ng,
      };
    }

    reset("beg");
    if (lsQuery.matches) syncLandscape(); // 初始即横屏：记住倍率并拉满

    return () => {
      ac.abort(); // 摘除全部事件监听
      if (timerId) clearInterval(timerId);
      if (touchTimer) clearTimeout(touchTimer);
      if (win.__op) delete win.__op;
    };
  }, []);

  return (
    <div ref={rootRef}>
      <FlopSprites />
      {/* 标题行：与首页「新闻」同款 .news_head（黄 h1 + 级别筛选 tabs 紧跟右侧）；
          右侧三个独立开关（NF / 无猜 / 全屏）margin-left:auto 推到行右，悬停出气泡说明
          （2026-10-14 张老师定） */}
      <div className="news_head">
        <h1>在线扫雷</h1>
        <div className="ranking_tabs news_tabs" id="level_tabs">
          <span className="current" data-lv="beg">初级</span>
          <a data-lv="int">中级</a>
          <a data-lv="exp">高级</a>
        </div>
        <div className="gswitches">
          <label className="gsw">
            <input type="checkbox" id="sw_nf" />
            <span className="track" />
            <span className="sw_name">NF</span>
            <span className="tip">禁旗模式：不能插旗，全程只靠开格决胜</span>
          </label>
          <label className="gsw">
            <input type="checkbox" id="sw_ng" />
            <span className="track" />
            <span className="sw_name">无猜</span>
            <span className="tip">踩雷自动重排本局，盲点必开出空域，永远不用猜</span>
          </label>
          <label className="gsw">
            <input type="checkbox" id="sw_qm" />
            <span className="track" />
            <span className="sw_name">问号</span>
            <span className="tip">开启后右键按 标雷 → 问号 → 取消 三态循环</span>
          </label>
          <label className="gsw">
            <input type="checkbox" id="sw_fs" />
            <span className="track" />
            <span className="sw_name">全屏</span>
            <span className="tip">游戏区域自动拉满整个屏幕，按 Esc 退出</span>
          </label>
        </div>
      </div>

      <div id="game_area">
        <div className="gwrap">
          <div className="gframe" id="gframe">
            <div className="gbar">
            <svg className="ledc" id="led_mines" viewBox="0 0 410 250" role="img" aria-label="剩余雷数">
              <use href="#top-counters" />
              <use className="d" href="#count-0" x="20" y="20" />
              <use className="d" href="#count-1" x="150" y="20" />
              <use className="d" href="#count-0" x="280" y="20" />
            </svg>
            <button className="face" id="face_btn" title="重新开始" type="button">
              <svg viewBox="0 0 260 260" width="26" height="26"><use id="face_use" href="#face-normal" /></svg>
            </button>
            <svg className="ledc" id="led_time" viewBox="0 0 410 250" role="img" aria-label="计时">
              <use href="#top-counters" />
              <use className="d" href="#count-0" x="20" y="20" />
              <use className="d" href="#count-0" x="150" y="20" />
              <use className="d" href="#count-0" x="280" y="20" />
            </svg>
          </div>
          <div className="gboard_wrap">
            <div className="board size16 game" id="gboard">
              <table cellPadding="0" cellSpacing="0"><tbody id="gtbody" /></table>
              {/* 矢量管线整盘渲染面（≥1.5x 才显示）：table 管布局与命中，视觉由这张 SVG 画 */}
              <svg className="vecboard" id="vec_board" aria-hidden="true" />
            </div>
          </div>
          <div className="gname" id="gname">初级 8×8 · 10 雷</div>
          </div>
          {/* 结算报告浮窗：游戏结束在桌面版左侧显示，再开局隐藏；内容由 JS 注入 */}
          <div className="greport" id="greport" />
        </div>
        <div className="gzoom">
          <span className="gz_label">比例</span>
          <input type="range" id="zoom_range" min="0.5" max="2.5" step="0.05" defaultValue="1" />
          <span className="gz_val" id="zoom_val">1.00x</span>
          <button className="gz_reset" id="zoom_reset" type="button">重置</button>
        </div>

        {/* 底部不再显示进度/剩余/3BV 等任何文字信息（2026-10-14 张老师定） */}
        <div className="gtools">
          <button className="flagmode_btn" id="flagmode_btn" type="button">插旗模式</button>
        </div>
      </div>
    </div>
  );
}
