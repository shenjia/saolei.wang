"use client";

// 在线玩（一期：纯前端娱乐局，不存录像、成绩不入排行）
// 引擎为自有实现（布雷 / 首击 3×3 保护 / flood 展开 / chord / 标准 3BV / 0.01s 计时），
// 行为经 design/online-play.html 多轮 playwright 自验；外观复刻 flop player 经典银灰。
// 二期预留：JS 端编码标准 AVF → 走现有上传/审核管线上榜。
// 三期（2026-10-14）：级别筛选加「自定义」——弹窗设置宽/高/雷数，确认后按规格开局，
// 显示比例自动适配（超宽/超高自动缩小到完整可见），规格入 localStorage。

import { useEffect, useRef } from "react";
import { FlopSprites } from "./FlopSprites";

/* 各级别 3BV 统计区间（服务端 /online page 从 level_3bv_range 表读取注入） */
export type BvRanges = Record<"beg" | "int" | "exp", { min: number; max: number }>;

/* localStorage 设置键（2026-10-14 二期：全部设置入 localStorage 记住） */
const LS_KEY = "online_play_settings";

/* 自定义规格范围（三期，2026-10-14 18:2x 张老师定）：
   下限 8——8×8 以下盘面撑不住 #page 版式（格子太少时 gframe 过窄、页脚版块会被挤变形）；
   上限 99。
   ⚠️ 必须放模块顶层——JSX 渲染作用域够不着 useEffect 闭包内的常量
   （2026-10-14 别线会话曾放闭包内导致 CUS_MIN is not defined 整页崩溃） */
const CUS_MIN = 8, CUS_MAX = 99;

/* 自定义滑杆拖动时盘面重建的节流间隔（ms）。99×99 全量重建 + 重绘每帧都做会卡手，
   张老师 2026-10-14 18:19 定：拖动时盘面变化允许 250ms 一次（leading 立即 + trailing 终值） */
const CUS_APPLY_MS = 250;

export function OnlinePlay({ bvRanges }: { bvRanges: BvRanges }) {
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

    /* 级别口径与站内排行一致（lib/config.ts：beg 8×8，2026-10-14 张老师指正）。
       cus＝自定义盘（三期）：规格来自弹窗滑杆，宽/高 8–99、雷 1..格数-9（首击 3×3 保护后仍须有余地） */
    const LEVELS: Record<string, { x: number; y: number; m: number }> = {
      beg: { x: 8, y: 8, m: 10 },
      int: { x: 16, y: 16, m: 40 },
      exp: { x: 30, y: 16, m: 99 },
    };
    let lv = "beg", W = 8, H = 8, M = 10;
    /* 自定义规格（默认 20×15·40 雷起步）；lv==="cus" 时 LEVELS 里无行，规格全靠它 */
    let cusSpec = { w: 20, h: 15, m: 40 };
    function levelSize(l: string): { x: number; y: number; m: number } {
      if (l === "cus") return { x: cusSpec.w, y: cusSpec.h, m: cusSpec.m };
      return LEVELS[l];
    }
    /* 自定义规格校验：通过返回 null，不通过返回原因（弹窗行内提示） */
    function cusError(w: number, h: number, m: number): string | null {
      if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(m)) return "请填写数字";
      if (w < CUS_MIN || h < CUS_MIN) return "宽、高不能小于 " + CUS_MIN;
      if (w > CUS_MAX || h > CUS_MAX) return "宽、高不能大于 " + CUS_MAX;
      if (m < 1) return "雷数至少为 1";
      if (m > w * h - 9) return "雷数过多（需留出首击 3×3 保护区）";
      return null;
    }
    /* NF / 无猜为独立开关（可叠加，2026-10-14 张老师定）；全屏开关只控制显示、不影响对局；
       问号开关（默认关）只影响右键循环是否经过问号态，切换不重开。
       二期起这些开关收进设置浮窗，初始值从 localStorage 恢复 */
    let nf = false, ng = false, qmark = false;
    /* 3BV 范围（按级别独立记忆）：默认＝该级别完整统计区间；
       布雷时拒绝范围外盘面重掷（见 placeMines），最小差 10 由浮窗交互保证 */
    const bvSel: Record<string, { lo: number; hi: number }> = {};
    for (const k of Object.keys(bvRanges) as (keyof BvRanges)[]) {
      const r = bvRanges[k];
      bvSel[k] = { lo: r.min, hi: r.max };
    }
    /* localStorage 读取：解析失败/缺字段时静默用默认值（隐私模式同） */
    function loadSettings() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw) as {
          nf?: boolean; ng?: boolean; qmark?: boolean; bv?: Record<string, { lo: number; hi: number }>;
          cus?: { w: number; h: number; m: number };
        };
        if (typeof s.nf === "boolean") nf = s.nf;
        if (typeof s.ng === "boolean") ng = s.ng;
        if (typeof s.qmark === "boolean") qmark = s.qmark;
        if (s.cus && !cusError(s.cus.w, s.cus.h, s.cus.m)) cusSpec = { ...s.cus };
        if (s.bv) {
          for (const k of Object.keys(bvSel)) {
            const r = bvRanges[k as keyof BvRanges], b = s.bv[k];
            if (b && Number.isFinite(b.lo) && Number.isFinite(b.hi)) {
              const lo = Math.max(r.min, Math.min(r.max, Math.round(b.lo)));
              const hi = Math.max(r.min, Math.min(r.max, Math.round(b.hi)));
              if (hi - lo >= 10) bvSel[k] = { lo, hi };
            }
          }
        }
      } catch { /* 隐私模式 / 脏数据：用默认 */ }
    }
    function saveSettings() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ nf, ng, qmark, bv: bvSel, cus: cusSpec }));
      } catch { /* 隐私模式 */ }
    }
    loadSettings();
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
    /* ---- 渲染：全程矢量（2026-10-14 张老师定：矢量版对齐修好后弃用像素版）----
       flop 矢量贴图，任意倍率边缘平滑。VEC_MAP 把引擎态类名映射到 symbol id。 */
    const VEC_MAP: Record<string, string> = {
      /* 未开格类用 solid 实心面变体（棋盘垫深灰底后，透明面会透灰——见 FlopSprites 注释） */
      bb: "cell-normal-solid", bf: "cell-flag-solid", bq: "cell-question-solid",
      b0: "cell-number-0", b1: "cell-number-1", b2: "cell-number-2", b3: "cell-number-3",
      b4: "cell-number-4", b5: "cell-number-5", b6: "cell-number-6", b7: "cell-number-7",
      b8: "cell-number-8", bm: "cell-mine", bn: "cell-flag-wrong",
    };
    /* 整盘单 SVG 渲染面（2026-10-14 二次返工，治「像素级错位」）：
       上一版每格各自内嵌 <svg>，分数倍率下各格落在不同亚像素相位（zoom2.1 实测格宽
       33.594px、格坐标 .625/.219/.813…），每格独立光栅化 → 格缘反锯齿深浅不一＝错位。
       flop 原版同构方案：整盘一张 <svg> 覆盖层，所有格子共用同一坐标系、一次光栅化，
       任意倍率网格完全均匀。table 只承担布局与命中（覆盖层 pointer-events:none）；
       td 语义类（bb/b1/bm…）恒保持——败局 bm/bn 补绘检测用。 */
    let vecUse: SVGUseElement[] = [];
    function buildVecBoard() {
      const cw = gboard.clientWidth, ch = gboard.clientHeight;
      if (!cw || !ch) return; // tbody 未建时测不到尺寸，reset 里会再调
      const svg = $("vec_board") as unknown as SVGSVGElement;
      svg.setAttribute("viewBox", "0 0 " + cw + " " + ch);
      svg.setAttribute("preserveAspectRatio", "none");
      /* 底铺一层深灰（与 gboard CSS 背景同色，#808080 = cell-press 边框灰）：
         cell-press 右/下 8 单位透明条 + 亚像素舍入缝都透出它 → 格间成均匀深灰细线
         （2026-10-14 张老师定，替代原先透出的银白亮缝）；每格一个 <use>，
         x/y 取 16 的整数倍 → 与 table 格严格对齐 */
      let s = '<rect width="100%" height="100%" fill="#808080"/>';
      for (let i = 0; i < W * H; i++) {
        s += '<use href="#cell-normal-solid" x="' + (i % W) * 16 + '" y="' + ((i / W) | 0) * 16 + '" width="16" height="16"/>';
      }
      svg.innerHTML = s;
      vecUse = Array.from(svg.querySelectorAll(":scope > use")) as SVGUseElement[];
    }
    function paintCell(td: HTMLTableCellElement, cls: string) {
      td.className = cls;
      td.innerHTML = "";
      const i = (td.parentElement as HTMLTableRowElement).rowIndex * W + td.cellIndex;
      const sym = VEC_MAP[cls];
      if (vecUse.length) vecUse[i]?.setAttribute("href", sym ? "#" + sym : "");
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
      vecUse[i]?.setAttribute("href", "#cell-mine-bomb");
    }
    /* 全盘重绘（重开 / 盘面重建） */
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
    function placeMinesOnce(first: number) {
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
    /* 3BV 范围约束（2026-10-14 二期）：完整范围（=统计区间原样）时跳过校验（零成本，
       与旧行为完全一致）；收窄过的范围重掷直到 3BV 落在 [lo, hi] 且离两边留 ≥3 余量
       （中心偏置——无猜重排会让 3BV 小幅漂移，贴边生成的盘一漂就出界）；
       300 次内没找到带余量的就接受首个落在范围内的，再没有接受最接近中心的
       （极窄范围物理上难以命中的兜底，娱乐局可接受）。
       定稿的盘同时存 origMines——无猜重排的「贴原盘」锚点（见 noGuessOnce）。 */
    let origMines: Uint8Array | null = null;
    function placeMines(first: number) {
      placeMinesOnce(first);
      if (!bvRangeFull()) {
        const sel = bvSel[lv];
        const mid = (sel.lo + sel.hi) / 2;
        const margin = 3;
        let best = board3bv, bestDist = Math.abs(best - mid), seenInRange = false;
        for (let tries = 0; tries < 300; tries++) {
          const ok = board3bv >= sel.lo && board3bv <= sel.hi;
          if (ok) {
            if (!seenInRange) { seenInRange = true; best = board3bv; bestDist = Math.abs(best - mid); }
            if (board3bv >= sel.lo + margin && board3bv <= sel.hi - margin) break; // 带余量，收工
          } else if (Math.abs(board3bv - mid) < bestDist && !seenInRange) {
            best = board3bv; bestDist = Math.abs(best - mid);
          }
          if (tries < 299) placeMinesOnce(first);
        }
      }
      origMines = mines!.slice();
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
    /* 必雷判定（2026-10-14 张老师定）：click 被某个已开数字 100% 锁死（该数字的
       隐藏邻居数恰等于数字值且 click 是其中之一）→ 直接判负，不进任何重排路径，
       盘面与 3BV 零变化。子集约束（如 1-2-1 模式的推理雷）不在此列——那些仍由
       求解器兜底（重排无解同样判负）。 */
    function isForcedMine(i: number): boolean {
      for (const a of neighbors(i)) {
        if (state[a] !== 1 || nums![a] === 0) continue;
        const hid = neighbors(a).filter((c) => state[c] !== 1);
        if (hid.length === nums![a]) return true; // 邻居数字锁死全部隐藏格
      }
      return false;
    }
    /* 3BV 范围是否完整（=该级别统计区间原样）：完整时重排也无需校验（零成本）。
       自定义盘（cus）无统计区间，视为完整（跳过范围校验，重排全速） */
    function bvRangeFull(): boolean {
      if (lv === "cus") return true;
      const r = bvRanges[lv as keyof BvRanges], s = bvSel[lv];
      return s.lo === r.min && s.hi === r.max;
    }
    /* 极小平移救回（2026-10-14 修复 3BV 范围失效的治本方案）：
       把 click（及其 opening 3×3）里的雷平移到「与源格相邻已开格集合完全相同」的
       隐藏空位——每个已开数字：挪出 -1 与挪入 +1 恰好抵消，数字零变化；
       盘面其余格不动，3BV 漂移极小。目标位按签名匹配随机选 → 出范围可换位重试。 */
    function minimalSave(click: number, makeOpening: boolean): boolean | null {
      const n = W * H;
      const clearSet = [click];
      if (makeOpening) for (const a of neighbors(click)) if (state[a] !== 1) clearSet.push(a);
      const inClear = new Uint8Array(n);
      for (const c of clearSet) inClear[c] = 1;
      const moving: number[] = [];
      for (const c of clearSet) if (mines![c]) moving.push(c);
      if (!moving.length) return true; // 本就无雷（安全盲点直接开）
      /* 源格的相邻已开格签名（排序 id 串）；目标位签名必须与对应源格完全一致 */
      const sigOf = (c: number) => neighbors(c).filter((a) => state[a] === 1).sort((x, y) => x - y).join(",");
      /* 候选目标位按签名分桶：隐藏、非雷、不在清空区 */
      const bySig = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        if (state[i] === 1 || mines![i] || inClear[i]) continue;
        const s = sigOf(i);
        if (!bySig.has(s)) bySig.set(s, []);
        bySig.get(s)!.push(i);
      }
      const newMines = mines!.slice();
      for (const src of moving) {
        const s = sigOf(src);
        const pool = bySig.get(s);
        if (!pool || !pool.length) return null; // 该源格无同签名空位 → 不适用
        const p = (Math.random() * pool.length) | 0;
        const tgt = pool[p];
        pool.splice(p, 1); // 占用
        newMines[src] = 0;
        newMines[tgt] = 1;
        /* 目标位被占雷后，其它签名的桶里若有格子与它互为邻居也不受影响（隐藏格数字会重算） */
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
    /* 无猜重排（2026-10-14 三修，张老师报：重排后界面数字变化 + 触发无猜明显卡顿）：
       铁律＝重排绝不允许改变任何已显示数字（verifyConsistency 在每个接受点终检，
       不满足即回滚不生效）；3BV 范围是软约束（尽力满足，冲突时让位给数字一致性）。
       性能预算＝平移 ≤8 + 重排 ≤4 + 降级平移 ≤8 + 终局重排 1（此前 50+50+
       regenFallback(120×300 重掷) 是卡顿主源，且 regenFallback 的数字校验
       是恒真式（比较的是换过的 nums），曾放行换数字的盘——已整体删除）。 */
    function tryNoGuess(click: number, makeOpening: boolean): boolean {
      const n = W * H;
      const sel = lv === "cus" ? { lo: 0, hi: 1e9 } : bvSel[lv];
      const checkBv = !bvRangeFull();
      const hasMargin = sel.lo + 2 <= sel.hi - 2;
      const bvOk = (strict: boolean) => {
        const lo = strict && hasMargin ? sel.lo + 2 : sel.lo;
        const hi = strict && hasMargin ? sel.hi - 2 : sel.hi;
        return board3bv >= lo && board3bv <= hi;
      };
      /* 数字一致性终检：每个已开格的雷邻数必须仍等于备份值（玩家所见） */
      function verifyConsistency(oldNums: Uint8Array): boolean {
        for (let i = 0; i < n; i++) {
          if (state[i] !== 1) continue;
          let cnt = 0;
          for (const a of neighbors(i)) if (mines![a]) cnt++;
          if (cnt !== oldNums[i]) return false;
        }
        return true;
      }
      /* 完整范围（含 cus 自定义盘）：单次重排 + 终检保险（DFS 锚线索约束，
         理论上恒一致；终检是防御深度——失败即回滚按未救处理） */
      if (!checkBv) {
        const bakM = mines ? mines.slice() : null;
        const bakN = nums ? nums.slice() : null;
        const bakR = bvRegions, bakS = bvSingles, bakI = bvIslands, bakB = board3bv;
        const ok = noGuessOnce(click, makeOpening, n);
        if (ok && bakN && verifyConsistency(bakN)) return true;
        if (ok) {
          mines = bakM!; nums = bakN!;
          bvRegions = bakR; bvSingles = bakS; bvIslands = bakI; board3bv = bakB;
        }
        return false;
      }
      /* 范围收窄：分层降级，每层都过终检 */
      const bakMines = mines ? mines.slice() : null;
      const bakNums = nums ? nums.slice() : null;
      const bakBvR = bvRegions, bakBvS = bvSingles, bakBvI = bvIslands, bakBv = board3bv;
      const restore = () => {
        mines = bakMines!; nums = bakNums!;
        bvRegions = bakBvR; bvSingles = bakBvS; bvIslands = bakBvI; board3bv = bakBv;
      };
      /* ① 极小平移：同签名抵消 → 数字零变化，3BV 漂移小；先严后宽 */
      for (let t = 0; t < 8; t++) {
        const r = minimalSave(click, makeOpening);
        if (r === null) break; // 无同签名空位，平移不适用
        if (bvOk(t < 5) && verifyConsistency(bakNums!)) return true;
        restore();
      }
      restore();
      /* ② 整盘重排（锚开局原盘）：DFS 锚线索约束 → 数字一致 */
      for (let t = 0; t < 4; t++) {
        const ok = noGuessOnce(click, makeOpening, n);
        if (!ok) break; // 无解（该格被线索锁死/超时）：重排路径终结
        if (bvOk(t < 2) && verifyConsistency(bakNums!)) return true;
        restore();
      }
      restore();
      /* ③ 降级「仅救本格」平移（约束最弱）。安全盲点（click 本无雷）到此为止：
         放弃换空域、原盘照常开数字格（没踩雷，无猜承诺不受影响）——省掉重排开销 */
      if (!bakMines![click]) return false;
      for (let t = 0; t < 8; t++) {
        const r = minimalSave(click, false);
        if (r === null) break;
        if (verifyConsistency(bakNums!)) return true; // 范围已尽力，数字一致即接受
        restore();
      }
      restore();
      /* ④ 终局：仅救本格重排一次（数字一致即接受，范围让位） */
      const finalOk = noGuessOnce(click, false, n);
      if (finalOk && verifyConsistency(bakNums!)) return true;
      restore();
      return false;
    }
    function noGuessOnce(click: number, makeOpening: boolean, n: number): boolean {
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
      /* 贴「开局原盘」取解（2026-10-14 修复）：已开数字从未变过，开局原盘恒满足
         frontier 约束——锚它取解每次重排都从同一起点出发，杜绝「锚当前盘」的
         连锁漂移（当前盘可能已被历次重排换过）。15% 反转保留随机探索。
         完整范围（无 origMines 约束需求）或无 origMines 时锚当前盘（旧行为）。 */
      const oldForBias = origMines ?? mines!;
      const origVal = new Int8Array(F);
      frontier.forEach((cell, k) => { origVal[k] = oldForBias[cell] ? 1 : 0; });
      let nodes = 0;
      function backFeasible(): boolean {
        let fMines = 0;
        for (let k = 0; k < F; k++) if (assign[k] === 1) fMines++;
        const needBack = M - fMines;
        return needBack >= 0 && needBack <= back.length;
      }
      function dfs(t: number): boolean {
        if (t === order.length) return backFeasible();
        if (++nodes > 200000) return false; // 中高级盘超时兜底（原 100 万卡顿主源之一）
        const k = order[t];
        const a = origVal[k], b = 1 - a;
        const vals = Math.random() < 0.85 ? [a, b] : [b, a];
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
      /* 应用新雷分布：前沿按解；后方「保原盘」补齐（2026-10-14 修复）——
         优先保留锚定盘（origMines，缺省当前盘）已在后方的雷位（开局盘在范围内，
         保得越多越不会跑），差额（新解 frontier 雷数 ≠ 原盘时）才随机补。
         范围收窄时启用；完整范围下走原随机撒（与旧行为一致，重排更「洗得开」） */
      const oldMines = origMines ?? mines!;
      const keepOld = !bvRangeFull();
      const newMines = new Uint8Array(n);
      frontier.forEach((cell, k) => { if (assign[k] === 1) newMines[cell] = 1; });
      let fMines = 0;
      for (let k = 0; k < F; k++) if (assign[k] === 1) fMines++;
      const needBack = M - fMines;
      let pool = back;
      if (keepOld) {
        /* 保原盘：后方已雷位先尽量保留（超出的按序丢弃），剩余缺口从干净位随机补 */
        let kept = 0;
        const keptSet: number[] = [], free: number[] = [];
        for (const b of back) {
          if (oldMines[b] && kept < needBack) { keptSet.push(b); kept++; }
          else free.push(b);
        }
        for (const b of keptSet) newMines[b] = 1;
        pool = free;
        for (let j = 0; j < needBack - kept; j++) {
          const p = (Math.random() * (pool.length - j)) | 0;
          newMines[pool[p]] = 1;
          pool[p] = pool[pool.length - 1 - j];
        }
      } else {
        for (let j = 0; j < needBack; j++) {
          const p = (Math.random() * (pool.length - j)) | 0;
          newMines[pool[p]] = 1;
          pool[p] = pool[pool.length - 1 - j];
        }
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
        /* 必雷格（被已开数字 100% 锁死）：直接判负，绝不重排、盘面与 3BV 零变化
           （2026-10-14 张老师定）。其余踩雷才走无猜救回。重排不弹任何提醒
           （张老师定：笑脸/盘面状态已够） */
        if (!ng || isForcedMine(i)) { lose(i); return; }
        const saved = (isBlind(i) && tryNoGuess(i, true)) || tryNoGuess(i, false);
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
      const stnb = hasBv && lv !== "cus"
        ? (87.420 * ln * ln - 155.829 * ln + 115.708) / qg * Math.sqrt(solvedBv / board3bv)
        : 0;
      /* 玩家实际插的旗数（胜利结算前会先抓这个值，自动补旗不算） */
      const playerFlags = M - flagsLeft();
      /* 每项第三列是 hover 气泡的解释（沿用 flop 原版 title 语义，中文一句话；含公式） */
      const rows: [string, string, string][] = [
        ["RTime", f3(t) + " (" + (Math.floor(t) + 1) + ")", "本局实际用时（秒），括号内为按秒进位的录像计分时间"],
        ["Est RTime", hasBv ? f3(est) + " (" + (Math.floor(est) + 1) + ")" : "* (*)", "按完成度折算的估算用时 = 实际用时 × 3BV ÷ 已完成 3BV"],
        ["3BV", solvedBv + "/" + board3bv, "盘面理论最少点击次数（Bechtel 基准值），显示为 已完成 / 全盘总量"],
        ["3BV/s", hasBv ? f3(solvedBv / t) : "*", "每秒完成的 3BV 数 = 已完成 3BV ÷ 实际用时，衡量操作效率"],
        ["Ops", solvedOps + "/" + bvRegions.length, "开空区域（opening）的完成数 / 全盘总数"],
        ["Isls", solvedIsls + "/" + bvIslands.length, "孤立数字块（island）的完成数 / 全盘总数"],
        ["Left", stLeft + "@" + (t > 0 ? f3(stLeft / t) : "0.000"), "左键点击次数 @ 每秒点击频率"],
        ["Right", stRight + "@" + (t > 0 ? f3(stRight / t) : "0.000"), "右键点击次数 @ 每秒点击频率"],
        ["Double", stDouble + "@" + (t > 0 ? f3(stDouble / t) : "0.000"), "左右同按（和弦双击）次数 @ 每秒频率"],
        ["Ce", ce + "@" + (t > 0 ? f3(ce / t) : "0.000"), "有效点击次数（真正开出新格或完成 3BV 的点击）@ 每秒频率"],
        ["Cl", cl + "@" + (t > 0 ? f3(cl / t) : "0.000"), "总点击次数（左键 + 右键 + 双击）@ 每秒频率"],
        ["IOE", cl > 0 ? f3(solvedBv / cl) : "*", "效率指数 = 已完成 3BV ÷ 总点击次数"],
        ["ThrP", ce > 0 ? f3(solvedBv / ce) : "*", "吞吐效率 = 已完成 3BV ÷ 有效点击次数"],
        ["Corr", cl > 0 ? f3(ce / cl) : "*", "准确率 = 有效点击 ÷ 总点击次数"],
        ["Path", String(Math.round(stPath)), "鼠标移动路径的欧氏距离总和（像素）"],
        ["Flags", String(playerFlags), "玩家实际插旗数量（胜利时自动补的旗不计）"],
        ["RQP", hasBv ? f3((est * (est + 1)) / board3bv) : "*", "性价比 = 估算用时 × (估算用时 + 1) ÷ 3BV"],
        ["QG", hasBv ? f3(qg) : "*", "质量分 = 实际用时 ^ 1.7 ÷ 已完成 3BV"],
        ["STNB", hasBv && lv !== "cus" ? f3(stnb) : "*", "无猜综合评分（按难度与完成度归一化，越大越好）"],
      ];
      greport.innerHTML =
        '<div class="gr_title">数据统计</div>' +
        "<table>" +
        rows
          .map(
            (r) =>
              '<tr><td class="gt">' + r[0] + '</td><td class="gv">' + r[1] + '<span class="tip">' + r[2] + "</span></td></tr>"
          )
          .join("") +
        "</table>";
      greport.classList.add("show");
      syncReportZoom(); // 面板尺寸随当前游戏倍率（可能已被放大）
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
      const prevLv = lv, prevW = W, prevH = H;
      lv = level || lv;
      const L = levelSize(lv); W = L.x; H = L.y; M = L.m;
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
        cus: "自定义 " + W + "×" + H + " · " + M + " 雷",
      };
      gname.textContent = names[lv];
      /* 同盘面重开（点笑脸/F2）不重建任何 DOM——重建会造成页面跳动（2026-10-14 张老师报），
         只重置格子贴图；盘面尺寸变化（切难度/首建）才重建 tbody 与矢量覆盖层 */
      const gridChanged = W !== prevW || H !== prevH || !vecUse.length;
      if (gridChanged) {
        let html = "";
        for (let y = 0; y < H; y++) {
          html += "<tr>";
          for (let x = 0; x < W; x++) html += '<td class="bb"></td>';
          html += "</tr>";
        }
        tbody.innerHTML = html;
        buildVecBoard();
      }
      hitIdx = null;
      repaintAll();
      /* 级别筛选器：激活项重建为 span.current，其余为 a（ranking_tabs 结构）；
         NF / 无猜开关是原生 checkbox，状态自持、跨局保持，无需重绘。
         级别没变（点笑脸重开）不动它——outerHTML 重建会丢焦点且白排一版 */
      if (lv !== prevLv) {
        container.querySelectorAll("#level_tabs [data-lv]").forEach((el) => {
          const l = el.getAttribute("data-lv")!;
          el.outerHTML = l === lv
            ? '<span class="current" data-lv="' + l + '">' + el.textContent + "</span>"
            : '<a data-lv="' + l + '">' + el.textContent + "</a>";
        });
      }
      /* NF 开启时触屏「插旗模式」按钮无意义，隐藏 */
      flagBtn.classList.toggle("hidden", nf);
      /* 级别切换后浮窗 3BV 滑杆范围联动（浮窗开着时立即刷新） */
      syncBvSlider();
      /* 自定义宽盘扩版（张老师 17:48）：宽 >40 切盘时给 #page.main 加 .cus_wide
         （globals.css：≥1280 视口 max-width 放到 min(85vw,1400px)），
         1280 视口下 960→1088px（约 +128px）。标准级别/窄盘恢复常规版式 */
      pageEl?.classList.toggle("cus_wide", lv === "cus" && W > 40);
      /* 全屏/横屏中切换级别或重开后，按新盘面尺寸重新拉满；普通模式：
         级别实际切换（beg/int/exp↔cus）→ 按模式分离记忆应用（三期 v3）；
         同级别内规格变化（滑杆拖动）→ 保持当前倍率只重算封顶（拖杆跟手，
         不因记忆切换跳变）；同盘面重开不动 zoom，杜绝重排跳动 */
      if (document.fullscreenElement === root) fitZoomForFullscreen();
      else if (lsQuery.matches) fitZoomForLandscape();
      else if (gridChanged) {
        if (lv !== prevLv) applyModeZoom();
        else applyZoom(zoomCur, false);
      }
    }

    on($("level_tabs"), "click", (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest("[data-lv]");
      if (!t) return;
      const to = t.getAttribute("data-lv")!;
      if (to === "cus") {
        /* 自定义（v4 张老师 18:19 定）：点 tab 恒开窗——不做 toggle。
           原先「开→关」的 toggle 语义有两个坑：①连点/双击第二击把自己关掉，
           表现为「点了自定义却没弹窗」；②触屏设备 touch 后补发 click 同样双触发。
           关窗只走「外点 / Esc」（见文末 document 监听）。
           ⚠️ 必须 stopPropagation：reset("cus") 会重建 level_tabs DOM（outerHTML），
           本轮点击的原 tab 元素已脱离文档——冒泡到 document 的外点关闭判定里
           contains(tab) 必为 false，刚开的窗会被立刻关掉（playwright 实证过） */
        e.stopPropagation();
        openCusDialog();
        return;
      }
      if (to !== lv) reset(to);
    });
    /* 缩放率按模式分离记忆的切换钩子（三期 v3 张老师定）：
       进入自定义读 online_play_zoom_cus（无记忆用 1x——大盘默认原尺寸起步，
       超版式由 normalMaxZoom 自动缩），返回标准级别读 online_play_zoom
       （无记忆用 defaultZoom）。reset 内 applyZoom(false) 不写盘，
       记忆只在用户手动拖滑杆/重置时更新 */
    function applyModeZoom() {
      try {
        const raw = lv === "cus"
          ? localStorage.getItem("online_play_zoom_cus")
          : localStorage.getItem("online_play_zoom");
        const saved = raw === null ? NaN : parseFloat(raw);
        const base = saved > 0 ? saved : (lv === "cus" ? 1 : defaultZoom());
        applyZoom(base, false);
      } catch {
        applyZoom(lv === "cus" ? 1 : defaultZoom(), false);
      }
    }

    /* ---- 右上两图标按钮（2026-10-14 二期）：齿轮＝设置浮窗开合；全屏＝切换 ---- */
    const gearBtn = $("btn_settings");
    const fsBtn = $("btn_fs");
    const gsettings = $("gsettings");
    on(gearBtn, "click", (e: MouseEvent) => {
      e.stopPropagation();
      const open = gsettings.classList.toggle("open");
      gearBtn.classList.toggle("active", open);
      if (open) syncBvSlider();
    });
    on(gsettings, "click", (e: Event) => e.stopPropagation()); // 浮窗内点击不触发外点关闭
    on($("gs_close"), "click", () => {
      gsettings.classList.remove("open");
      gearBtn.classList.remove("active");
    });
    on(document, "click", (e: Event) => {
      if (!gsettings.classList.contains("open")) return;
      if (e.target === gearBtn || gsettings.contains(e.target as Node)) return;
      gsettings.classList.remove("open");
      gearBtn.classList.remove("active");
    });
    /* Esc 优先关浮窗（全屏中的 Esc 由浏览器处理退出全屏，两者不冲突） */
    on(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && gsettings.classList.contains("open")) {
        gsettings.classList.remove("open");
        gearBtn.classList.remove("active");
      }
    });

    /* ---- 自定义难度弹窗（2026-10-14 三期 v4，张老师 18:19 两连改）----
       无任何按钮——三个滑杆拖动即改变地图；点「自定义」tab 恒开窗（不 toggle），
       窗原本关着时按记忆规格回填滑杆；关窗只走外点/Esc。
       应用节流 CUS_APPLY_MS：连拖时不再每帧重建（99×99 每帧重建会卡手），
       leading 立即响应、trailing 保证终值落定。
       规格随手写 localStorage（LS_KEY.cus），重开 tab 恢复记忆值。 */
    const cusDlg = $("cus_dialog");
    const cusW = $("cus_w") as HTMLInputElement;
    const cusH = $("cus_h") as HTMLInputElement;
    const cusM = $("cus_m") as HTMLInputElement;
    const cusWv = $("cus_w_val");
    const cusHv = $("cus_h_val");
    const cusMv = $("cus_m_val");
    /* 读滑杆当前值（滑杆 min/max 恒合法，parseInt 必成功；防御 NaN 兜底） */
    const cusVal = (el: HTMLInputElement) => {
      const v = parseInt(el.value, 10);
      return Number.isFinite(v) ? v : parseInt(el.min || String(CUS_MIN), 10);
    };
    function syncCusVals() {
      cusWv.textContent = String(cusVal(cusW));
      cusHv.textContent = String(cusVal(cusH));
      cusMv.textContent = String(cusVal(cusM));
    }
    function clampCusMines() {
      const cap = cusVal(cusW) * cusVal(cusH) - 9;
      cusM.max = String(cap);
      if (cusVal(cusM) > cap) cusM.value = String(cap);
    }
    /* 应用节流（250ms）：连续拖动时每个节流窗口只重建一次盘面，窗口内只标记
       dirty，窗口结束若有新值立刻再应用一次（终值一定落定）；首次拖动立即生效。
       ⚠️ trailing 回补前必须确认仍在自定义级别：拖完 250ms 内点「初级/中级」时
       定时器还挂着，若无脑 reset("cus") 会把用户刚切走的盘面强拉回自定义 */
    let cusTimer: ReturnType<typeof setTimeout> | null = null;
    let cusDirty = false;
    function applyCusNow() {
      cusSpec = { w: cusVal(cusW), h: cusVal(cusH), m: cusVal(cusM) };
      saveSettings();
      reset("cus");
    }
    function applyCusLive() {
      if (cusTimer !== null) { cusDirty = true; return; }
      applyCusNow();
      cusTimer = setTimeout(() => {
        cusTimer = null;
        if (cusDirty) {
          cusDirty = false;
          if (lv === "cus") applyCusLive(); // 已切走则丢弃（规格仍留在滑杆上，下次进来自会回填）
        }
      }, CUS_APPLY_MS);
    }
    /* 弹窗锚定（张老师 18:41 定）：贴「自定义」tab 正下方、与之水平居中对齐。
       原先锚 .news_head 左缘（left:0），看着像挂在标题左端、离 tab 老远。
       量法用 offset 系（CSS px，与页级 zoom 无关）：tab 与弹窗的 offsetParent 同为
       .news_head，所以 tab.offsetLeft/offsetWidth 可直接与弹窗 offsetWidth 相减；
       若走 rect 反算则须除以 pageZoom（窄屏 #page 有页级缩放），offset 系免这一层。
       越界（窄屏弹窗比容器宽）钳进容器，左右各留 4px */
    function positionCusDialog() {
      const tab = $("level_tabs").querySelector('[data-lv="cus"]') as HTMLElement | null;
      if (!tab) return;
      const head = cusDlg.offsetParent as HTMLElement | null; // display:none（未开窗）时为 null，跳过
      if (!head || tab.offsetParent !== head) return; // 锚系不一致（结构变动）时保持不动，不瞎摆
      const pad = 4;
      const center = tab.offsetLeft + tab.offsetWidth / 2;
      const maxLeft = Math.max(head.clientWidth - cusDlg.offsetWidth - pad, pad);
      cusDlg.style.left =
        Math.round(Math.min(Math.max(center - cusDlg.offsetWidth / 2, pad), maxLeft)) + "px";
      cusDlg.style.top = Math.round(tab.offsetTop + tab.offsetHeight + 10) + "px";
    }
    function openCusDialog() {
      /* 滑杆值只在窗原本关着时按记忆规格回填；已开着（连点 tab）不回填，
         免得把玩家正拖到一半的值弹回去 */
      if (!cusDlg.classList.contains("open")) {
        cusW.value = String(cusSpec.w);
        cusH.value = String(cusSpec.h);
        clampCusMines(); // 先按新宽高收缩雷数上限
        cusM.value = String(Math.min(cusSpec.m, parseInt(cusM.max, 10)));
        syncCusVals();
      }
      cusDlg.classList.add("open");
      if (lv !== "cus") reset("cus"); // 点自定义＝选定级别立即切盘（同点初级/高级语义）
      positionCusDialog(); // 须在 reset 之后：tab 由 a 变 span.current 字重变了，宽度要重算
    }
    function closeCusDialog() { cusDlg.classList.remove("open"); }
    on(cusW, "input", () => { clampCusMines(); syncCusVals(); applyCusLive(); });
    on(cusH, "input", () => { clampCusMines(); syncCusVals(); applyCusLive(); });
    on(cusM, "input", () => { syncCusVals(); applyCusLive(); });
    on(cusDlg, "click", (e: Event) => e.stopPropagation()); // 窗内点击不冒泡到外点关闭
    on(document, "click", (e: Event) => {
      if (!cusDlg.classList.contains("open")) return;
      if (cusDlg.contains(e.target as Node)) return;
      /* 点「自定义」tab 的 click 已在 tabs 处理器里 stopPropagation，正常到不了这里；
         此处留兜底（若哪天去掉那个 stopPropagation，reset 重建 tabs 会让点击的原元素
         脱离文档、contains 判 false → 刚开的窗会秒关，故用 closest 定位 target） */
      const tab = (e.target as HTMLElement).closest('[data-lv="cus"]');
      if (tab && $("level_tabs").contains(tab)) return;
      closeCusDialog();
    });
    on(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && cusDlg.classList.contains("open")) closeCusDialog();
    });

    /* ---- 设置浮窗内开关：NF / 无猜 切换即重开一局；问号只改右键循环 ---- */
    const swNf = $("sw_nf") as HTMLInputElement;
    const swNg = $("sw_ng") as HTMLInputElement;
    const swQm = $("sw_qm") as HTMLInputElement;
    on(swNf, "change", () => {
      nf = swNf.checked;
      if (nf && flagMode) flagBtn.click(); // 开 NF 前退出触屏插旗模式
      saveSettings();
      reset();
    });
    on(swNg, "change", () => {
      ng = swNg.checked;
      saveSettings();
      reset();
    });
    on(swQm, "change", () => { qmark = swQm.checked; saveSettings(); });

    /* ---- 全屏按钮（图标按钮，点击在全屏/非全屏间切换） ---- */
    on(fsBtn, "click", () => {
      if (document.fullscreenElement === root) document.exitFullscreen();
      else {
        const p = root.requestFullscreen ? root.requestFullscreen() : null;
        if (p && p.catch) p.catch(() => { /* 无手势被拒等：静默 */ });
      }
    });
    /* 全屏状态切换：进入时自动把游戏区比例拉满（记住原比例），
       退出（含 Esc）时恢复原比例并高亮全屏按钮 */
    on(document, "fullscreenchange", () => {
      const entered = document.fullscreenElement === root;
      fsBtn.classList.toggle("active", entered);
      fsBtn.title = entered ? "退出全屏" : "全屏";
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
      positionCusDialog(); // 窗口尺寸/换行变化后重新对准「自定义」tab（未开窗时内部直接跳过）
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
    /* 按下态贴图：平面下沉底（VEC_MAP.b0 = cell-number-0 ≡ cell-press，
       与 legacy 位图 b0 精灵同一外观） */
    function pressPaint(c: number) {
      const td = cellTd(c);
      td.className = "b0";
      td.innerHTML = "";
      vecUse[c]?.setAttribute("href", "#" + VEC_MAP["b0"]);
    }
    /* 单格按下态跟随：从旧格挪到 i 格 */
    function pressSingle(i: number) {
      if (pressCell === i) return;
      if (pressCell !== null && state[pressCell] === 0) paint(pressCell);
      pressCell = i;
      if (state[i] === 0) pressPaint(i);
    }
    /* 左右同按 3×3 按下态跟随：高亮挪到 i 格邻域 */
    function pressAround(i: number) {
      if (chordCells) chordCells.forEach((c) => { if (state[c] === 0) paint(c); });
      chordCells = neighbors(i).concat([i]).filter((c) => state[c] === 0);
      chordCells.forEach(pressPaint);
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
       缩放/窄屏断点下都成立。全屏/横屏由 fitZoom* 拉满（max=5），不走此封顶。
       自定义盘（三期）加高度封顶：常规三级盘高度有限（≤16 行）从不需要，自定义
       最高 50 行会被视口下方内容推出去——按「视口底到游戏区顶的可用高」反算
       宽/高两个方向的倍率取小，保证整个盘面完整可见不裁切（宽度仍按容器） */
    function normalMaxZoom() {
      if (document.fullscreenElement === root || lsQuery.matches) return 5;
      const gfR = gframe.getBoundingClientRect();
      const gaR = ($("game_area") as HTMLElement).getBoundingClientRect();
      if (gfR.width <= 0 || gaR.width <= 0) return 2.5;
      /* 下限 0.5（=滑杆 min）：窄窗连 1x 都放不下时按容器宽自动缩，保证不溢出。
         自定义大盘（cus）额外放宽到 0.3——99 宽盘即使扩版（.cus_wide）后
         仍可能超容器，需要更小的自动缩下限才能完整可见 */
      const zMin = lv === "cus" ? 0.3 : 0.5;
      let cap = Math.max(zMin, Math.min(2.5, (zoomCur * (gaR.width - 16)) / gfR.width)); // 左右各留 8px
      if (lv === "cus") {
        /* 高度方向：gfR.height 是渲染高（含 zoomCur×pz），约束
           base_h × zoom × pz ≤ 可用高（视口像素）→ hCap = zoomCur×可用高/gfR.height。
           可用高 = 视口底 − game_area 顶 − 底部余量 12px（页脚仍可滚动，正常） */
        const availH = window.innerHeight - gaR.top - 12;
        if (gfR.height > 0 && availH > 0) {
          const hCap = (zoomCur * availH) / gfR.height;
          cap = Math.max(zMin, Math.min(cap, hCap));
        }
      }
      return cap;
    }
    /* 首次进入（localStorage 无记忆）的默认比例（2026-10-14 张老师二定：固定 1.71）：
       此前按「高级盘刚好填满版块」动态计算，宽视口下会算到 2.1x+，观感偏大。
       现固定 1.71；窄屏放不下时由 applyZoom→normalMaxZoom 按容器宽自动封顶
       （≥0.5），手动调整仍写 localStorage 记忆（默认值 persist=false 不写盘） */
    function defaultZoom() {
      return 1.71;
    }
    function applyZoom(v: number, persist = true, max?: number) {
      const cap = max ?? normalMaxZoom();
      /* 大盘自动缩可低于滑杆 min（0.5）：cus 盘封顶 <0.5 时直接用封顶值
         （滑杆拖不到但自动适配到位——99 宽盘在 960 版式下需 ~0.55x 以下） */
      const floor = lv === "cus" ? Math.min(0.5, cap) : 0.5;
      v = Math.max(floor, Math.min(cap, v));
      zoomRange.max = String(cap); // 滑杆行程同步封顶，拖杆手感与实际一致
      gframe.style.zoom = String(v);
      zoomCur = v;
      zoomRange.value = String(v);
      zoomVal.textContent = v.toFixed(2) + "x";
      syncReportZoom(); // 结算面板同步缩放（显示中才生效）
      if (persist) {
        /* 缩放率按模式分离记忆（2026-10-14 三期 v3 张老师定）：自定义盘与标准级别
           各记各的（大盘常需 <1x、标准盘常 >1x，互窜体验差）；旧单键迁移见 loadZoom */
        try {
          localStorage.setItem(lv === "cus" ? "online_play_zoom_cus" : "online_play_zoom", String(v));
        } catch { /* 隐私模式 */ }
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
    /* 结算统计面板跟随游戏倍率缩放（2026-10-14 张老师：不缩放面板字太小看不清）。
       面板是 gframe 的兄弟节点（不继承游戏 zoom），故显式同步。
       上限：面板放大后不得越出视口——用 rect 实测反算基准宽/高（rect =
       基准尺寸 × 面板 zoom × 页级 zoom，当前 style.zoom 已知，一次除法解出），
       可用宽取 gframe 渲染左缘（已含游戏 zoom 与页级 zoom）减页面边距与贴边间隙，
       可用高取视口底到面板顶（面板 top 与 gframe 顶对齐）。
       低倍率下不放大过游戏倍率本身（跟手感），高倍率下按空间封顶防裁切 */
    function syncReportZoom() {
      if (!greport.classList.contains("show")) return;
      const rect = greport.getBoundingClientRect();
      const pz = pageZoom();
      const curZ = parseFloat(greport.style.zoom || "1") || 1;
      const rawW = rect.width / (curZ * pz); // 面板基准尺寸（未缩放布局尺寸）
      const rawH = rect.height / (curZ * pz);
      if (!rawW || rawW < 1 || !rawH || rawH < 1) return;
      const gfR = gframe.getBoundingClientRect();
      const availW = gfR.left - 12 - 14; // 视口左缘 12px + CSS 贴边间隙 14px
      const availH = window.innerHeight - gfR.top - 12;
      const cap = Math.max(0.5, Math.min(2.5,
        Math.min(availW / (rawW * pz), availH / (rawH * pz))));
      greport.style.zoom = String(Math.max(0.5, Math.min(zoomCur, cap)));
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

    /* ---- 3BV 范围双端点滑杆（2026-10-14 二期）----
       两条原生 range 叠放：轨道/填充条只负责视觉（CSS 变量 --lo/--hi 定位），
       thumb 透明轨道 pointer-events:none + thumb 自身 auto——两条滑杆互不挡命中。
       交互约束：上/下界最小差 10（拖过头自动钳回）；范围外拖不动。
       当前级别范围存 bvSel[lv]，改完立即写 localStorage；
       只影响之后生成的盘（进行中对局不重开——重开按钮/切级别才用新范围）。 */
    const bvLo = $("bv_lo") as HTMLInputElement;
    const bvHi = $("bv_hi") as HTMLInputElement;
    const bvDual = $("bv_dual") as HTMLElement;
    const bvHint = $("bv_range_hint");
    const bvCur = $("bv_cur");
    const LV_NAMES: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
    function syncBvSlider() {
      /* 自定义盘无统计区间：整个 3BV 区禁用（半透明 + 滑杆不可拖 + 提示文案） */
      const cus = lv === "cus";
      bvDual.parentElement!.classList.toggle("cus", cus);
      [bvLo, bvHi, $("bv_reset")].forEach((el) => {
        (el as HTMLInputElement).disabled = cus;
      });
      if (cus) {
        bvHint.textContent = "自定义盘面不支持 3BV 筛选";
        bvCur.textContent = "—";
        return;
      }
      const r = bvRanges[lv as keyof BvRanges], s = bvSel[lv];
      bvLo.min = bvHi.min = String(r.min);
      bvLo.max = bvHi.max = String(r.max);
      bvLo.value = String(s.lo); bvHi.value = String(s.hi);
      bvDual.style.setProperty("--lo", ((s.lo - r.min) / (r.max - r.min)) * 100 + "%");
      bvDual.style.setProperty("--hi", ((s.hi - r.min) / (r.max - r.min)) * 100 + "%");
      bvHint.textContent = LV_NAMES[lv] + "统计区间 " + r.min + "–" + r.max;
      bvCur.textContent = s.lo + " – " + s.hi;
    }
    on(bvLo, "input", () => {
      const r = bvRanges[lv as keyof BvRanges];
      let lo = Math.min(parseInt(bvLo.value, 10), bvSel[lv].hi - 10);
      lo = Math.max(r.min, Math.min(r.max, lo));
      bvSel[lv].lo = lo;
      saveSettings();
      syncBvSlider();
    });
    on(bvHi, "input", () => {
      const r = bvRanges[lv as keyof BvRanges];
      let hi = Math.max(parseInt(bvHi.value, 10), bvSel[lv].lo + 10);
      hi = Math.max(r.min, Math.min(r.max, hi));
      bvSel[lv].hi = hi;
      saveSettings();
      syncBvSlider();
    });
    /* 双端点滑杆恢复初始范围（与统计区间对齐） */
    on($("bv_reset"), "click", () => {
      const r = bvRanges[lv as keyof BvRanges];
      bvSel[lv] = { lo: r.min, hi: r.max };
      saveSettings();
      syncBvSlider();
    });
    /* 数据统计术语气泡越界翻转（2026-10-14 二版：气泡改在数值右侧、整行高亮）：
       面板整体常贴到视口底缘，靠底几行的气泡（行垂直居中）会出屏，
       故按实测空间改为向上弹（CSS 里 tr.tip-up 把气泡翻到行上方、三角朝下）。
       ⚠️ 判定用整行（鼠标多落在术语格 td.gt 上，closest("td.gv") 会取不到） */
    on(greport, "mouseover", (e: MouseEvent) => {
      const tr = (e.target as HTMLElement).closest("tr") as HTMLTableRowElement | null;
      if (!tr || !tr.querySelector("td.gv .tip")) return;
      tr.classList.toggle("tip-up", tr.getBoundingClientRect().bottom + 34 > window.innerHeight);
    });
    /* 比例的恢复/默认在文件末尾 reset("beg") 之后统一处理——tbody 未建时
       gframe 只有边框宽，此时量不出真实盘面尺寸（见 defaultZoom） */

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
      /* 弹窗开着（尤其输入框里打字）不响应重开快捷键 */
      if (cusDlg.classList.contains("open")) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
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
        bv3: () => board3bv,
        bvSel: () => ({ ...bvSel[lv] }),
        lv: () => lv,
        size: () => ({ w: W, h: H, m: M }),
        /* 诊断：单次重排的 bv（测分布用，不动盘面之外的任何状态） */
        ngOnce: (i: number, opening: boolean) => {
          const ok = noGuessOnce(i, opening, W * H);
          return ok ? board3bv : -1;
        },
      };
    }

    /* 设置浮窗控件初始状态（从 localStorage 恢复的开关勾选态 + 3BV 滑杆初值） */
    swNf.checked = nf;
    swNg.checked = ng;
    swQm.checked = qmark;
    syncBvSlider();

    reset("beg");
    /* 比例：有 localStorage 记忆直接应用；首次进入（无记忆）用 defaultZoom()
       按高级盘算出的最大比例起步（张老师定）。默认值不写盘——只有玩家
       手动拖滑杆/重置才记忆；全屏与横屏的自动拉满同样不入记忆。
       初始恒为标准级别（reset("beg")），只读标准键；cus 键在切自定义时读
       （见 level_tabs 处理器），两模式各自独立记忆（三期 v3 张老师定） */
    try {
      const raw = localStorage.getItem("online_play_zoom");
      const saved = raw === null ? NaN : parseFloat(raw);
      applyZoom(saved > 0 ? saved : defaultZoom(), false);
    } catch {
      applyZoom(defaultZoom(), false); // 隐私模式：读不到就用默认
    }
    if (lsQuery.matches) syncLandscape(); // 初始即横屏：记住倍率并拉满

    return () => {
      ac.abort(); // 摘除全部事件监听
      if (timerId) clearInterval(timerId);
      if (touchTimer) clearTimeout(touchTimer);
      if (cusTimer !== null) clearTimeout(cusTimer); // 拖杆节流残留的 trailing 定时器
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
          <a data-lv="cus">自定义</a>
        </div>
        {/* 右上角两个图标按钮（2026-10-14 二期张老师定）：齿轮＝设置浮窗；⛶＝全屏切换。
            news_head 需要相对定位给浮窗做锚（gsettings absolute top:100% right:0） */}
        <div className="gicons">
          <button className="gicon" id="btn_settings" title="设置" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
            </svg>
          </button>
          <button className="gicon" id="btn_fs" title="全屏" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>

        {/* 设置浮窗：齿轮点开；含 NF/无猜/问号开关、显示比例滑杆、3BV 范围双端点滑杆。
            全部状态入 localStorage（online_play_settings），比例仍走原 online_play_zoom 键 */}
        <div className="gsettings" id="gsettings">
          <div className="gs_head">设置<button className="gs_close" id="gs_close" type="button" aria-label="关闭">✕</button></div>
          {/* 开关名 ≤4 字（2026-10-14 张老师定），完整解释放 hover 气泡（.tip） */}
          <div className="gs_row">
            <span className="gs_name">NF</span>
            <label className="gsw"><input type="checkbox" id="sw_nf" /><span className="track" /></label>
            <span className="tip">禁旗模式：不能插旗，全程只靠开格决胜</span>
          </div>
          <div className="gs_row">
            <span className="gs_name">无猜</span>
            <label className="gsw"><input type="checkbox" id="sw_ng" /><span className="track" /></label>
            <span className="tip">踩雷自动重排本局，盲点必开出空域，永远不用猜</span>
          </div>
          <div className="gs_row">
            <span className="gs_name">问号</span>
            <label className="gsw"><input type="checkbox" id="sw_qm" /><span className="track" /></label>
            <span className="tip">右键按 标雷 → 问号 → 取消 三态循环</span>
          </div>
          <div className="gs_divider" />
          <div className="gs_zoom">
            <span className="zlabel">显示比例</span>
            <input type="range" id="zoom_range" min="0.5" max="2.5" step="0.05" defaultValue="1" />
            <span className="zval" id="zoom_val">1.00x</span>
            <button className="zreset" id="zoom_reset" type="button">重置</button>
          </div>
          <div className="gs_divider" />
          <div className="gs_bv">
            <div className="gs_bv_label">
              <span className="bname">3BV 范围</span>
              <span className="brange" id="bv_range_hint">初级统计区间 2–51</span>
              <span className="bcur" id="bv_cur">2 – 51</span>
            </div>
            <div className="dual" id="bv_dual">
              <div className="rail" /><div className="fill" />
              <input type="range" id="bv_lo" min="2" max="51" step="1" defaultValue="2" />
              <input type="range" id="bv_hi" min="2" max="51" step="1" defaultValue="51" />
            </div>
            <div className="gs_bv_vals">
              <span>下界</span>
              <button className="bv_reset" id="bv_reset" type="button">恢复全范围</button>
              <span>上界</span>
            </div>
          </div>
        </div>

        {/* 自定义难度弹窗（三期 v4，张老师 18:19 定）：无任何按钮——
            三滑杆拖动即改变地图（节流 250ms，拖动中不再每帧重建）；点 tab 恒开窗 */}
        <div className="cus_dialog" id="cus_dialog">
          <div className="cus_row">
            <span className="cname">宽度</span>
            <input type="range" id="cus_w" min={CUS_MIN} max={CUS_MAX} step={1} defaultValue="20" />
            <span className="cval" id="cus_w_val">20</span>
          </div>
          <div className="cus_row">
            <span className="cname">高度</span>
            <input type="range" id="cus_h" min={CUS_MIN} max={CUS_MAX} step={1} defaultValue="15" />
            <span className="cval" id="cus_h_val">15</span>
          </div>
          <div className="cus_row">
            <span className="cname">雷数</span>
            <input type="range" id="cus_m" min={1} max={291} step={1} defaultValue="40" />
            <span className="cval" id="cus_m_val">40</span>
          </div>
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

        {/* 比例控制条已移入设置浮窗（2026-10-14 二期张老师定：页面只留游戏本体） */}
        {/* 底部不再显示进度/剩余/3BV 等任何文字信息（2026-10-14 张老师定） */}
        <div className="gtools">
          <button className="flagmode_btn" id="flagmode_btn" type="button">插旗模式</button>
        </div>
      </div>
    </div>
  );
}
