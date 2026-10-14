"use client";

// 在线玩（一期：纯前端娱乐局，不存录像、成绩不入排行）
// 引擎为自有实现（布雷 / 首击 3×3 保护 / flood 展开 / chord / 标准 3BV / 0.01s 计时），
// 行为经 design/online-play.html 多轮 playwright 自验；外观复刻 flop player 经典银灰。
// 二期预留：JS 端编码标准 AVF → 走现有上传/审核管线上榜。
// 三期（2026-10-14）：级别筛选加「自定义」——弹窗设置宽/高/雷数，确认后按规格开局，
// 显示比例自动适配（超宽/超高自动缩小到完整可见），规格入 localStorage。
// 五期（2026-10-14 结算增强）：对局全程记录事件流（AVF 口径），结束出右侧结算面板
// （五围雷达 + 重玩本局 / 查看回放 / 下载录像）；雷达轴定义 / 评级 / 配色与录像详情页
// 同源（lib/videoscore.ts），只是渲染走字符串拼 SVG（面板是 innerHTML 注入流，挂不了 React）；
// 回放自研（不调 flopplayer）；下载为标准 AVF（lib/avfwrite.ts），Program 带
// saolei.wang Online 标记，上传路由据此拒绝入排行。
// 六期（2026-10-15 张老师定）：
//   ① 左侧「数据统计」面板默认**不显示**——新增设置开关「显示统计」，开启后**常驻**显示
//      （对局中每 100ms 随计时器实时刷新，结束后定格），关闭则任何时刻都不出现；
//   ② 回放不再插控制条（原「重放/播放暂停/速度/进度/退出」整条撤掉）：进入即自动播完，
//      回放中点「查看回放」＝从头重播（原实现是 early-return 无反应），退出走 Esc / 笑脸 /
//      「再来一局」（reset 内的 forceExitReplay）；
//   ③ 右侧面板四个按钮分两行：上「再来一局」「重玩本局」，下「查看回放」「下载录像」；
//   ④ 下载文件名对齐录像页规则（见 lib/avfwrite 的 onlineAvfFilename）：登录玩家带
//      `# 用户ID 英文名` 段，未登录省略。
// 七期（2026-10-15 张老师定）：
//   ① 结算面板首行不再报「完成！/ 踩雷」（笑脸状态已足够），改标题行：
//      左＝本局成绩（与录像详情页 h1 同格式同配色：级别名 + 级别色成绩 + NF），
//      右＝「评级：S+」——五围图（综合 STNB + 速度/效率/精准/手速）各轴组内分位加权出的
//      新评级（权重见 lib/videoscore.ts PERFORMANCE_WEIGHTS：STNB 占一半，四分项各 1/8）；
//   ② 移动端（<960px，桌面右侧面板的媒体查询不生效）完成一局改弹**屏幕居中浮层**：
//      全屏遮罩 + 居中卡片，点遮罩关闭；元素挂 body 直下（同 #fs_tip，避开 #page 页级 zoom）；
//   ③ 看过回放后把浮层重新弹出来（播完自动退出回放 / 手动退出都会回到本局表现浮层）。
// 八期（2026-10-15 张老师定）：
//   ① 踩雷局标题左侧显示灰色「未完成」（失败的用时没有展示意义）；
//   ② F 级配色 #6600cc → 暗灰 #8a8878（lib/videoscore.ts GRADE_COLORS 唯一来源，
//      实力/录像分析/结算评级所有雷达图同步）；
//   ③ 结算面板雷达宽度顶满面板内容宽（VideoAnalysisRadar fill 模式，原固定 160 废）；
//   ④ 状态栏（级别名+3BV/模式银条）整个取消——「没有意义」；「显示3BV」设置开关随之删除；
//   ⑤ 「显示统计」改口径：打开后也只在**游戏结束**时弹出数据面板（对局中不再常驻刷新）。

import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FlopSprites } from "./FlopSprites";
import { VideoAnalysisRadar } from "./VideoAnalysis";
import { buildOnlineAvf, onlineAvfFilename, type OnlineEvent } from "@/lib/avfwrite";
import { LEVEL_NAMES } from "@/lib/config";
import { paintRangeFill } from "@/lib/paintRange";
import type { VideoAnalysisPoint } from "@/lib/videoanalysis";
import {
  AXIS_METRICS,
  DIST_BUCKET_ALL,
  formatMetric,
  gradeColor,
  gradeFromPercent,
  gradeOf,
  percentOf,
  performanceOf,
} from "@/lib/videoscore";
import type { MetricKey } from "@/lib/videoscore";

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

/* ---- 自定义盘「主体板块自适应宽度」（三期 v7，2026-10-14 19:07 张老师定）----
   原先 cus 盘固定走 960 版式（宽 >40 才放宽），小盘（如默认 20×15 = 324px 盘面）
   在 960 板块里左右各留一大片空档。现改为按盘面渲染宽精算 #page 宽度：
     pageW = 盘面渲染宽 + PAGE_PAD，clamp 到 [PAGE_MIN_W, 视口可用, PAGE_MAX_W]
   宽度链实测（CSS px，1280 视口）：ga 宽 = pageW − GA_OFFSET
   （GA_OFFSET = box margin 8×2 + border 1×2 + padding 30×2 = 78），
   PAGE_PAD = GA_OFFSET + 22 使 normalMaxZoom 的宽度封顶恒略大于期望倍率（≥1），
   保证「页宽跟随盘面」与「盘面按容器自动缩」两个公式联立后一次收敛、不来回缩。 */
const PAGE_PAD = 100;   // 盘面之外需给 #page 留的总宽（盒装 78 + 视觉余量 22）
const GA_OFFSET = 78;   // #page 宽 → #game_area 内容宽的固定损耗
const PAGE_MIN_W = 480; // 下限：标题行 + 4 个级别 tab 一行放得下、弹窗（320）不出盒
const PAGE_MAX_W = 1400; // 上限：与旧 cus_wide 一致的扩版封顶
/* 手机横屏固定横向开销（布局 px）：页面边距 8 + 盒装 border/padding ~18
   + 视口滚动条/余量 → fitZoom* 与 normalMaxZoom 共用。用固定值而非 rect 实测：
   超宽盘会把布局视口撑爆、rect 全失真。zoom 挂 .gwrap 后银框（含竖排计数列）
   整体随盘缩放，拉满基准即整个银框窗，预留不再含框/计数列。
   ⚠️ 2026-10-15 横屏改沉浸模式后左栏（150px）已隐藏，预留从 240 大幅降到 40；
   同日二定「严格占满 100% 高度」把 #page 的 margin/padding 与 .box 的
   margin/padding 全部清零（CSS 横屏块），横向只余 box 左右各 1px 边框 → 预留 2 */
const LS_RESERVE_W = 2;

/* 雷达基准分布（服务端注入）：`${level}${nf?"_nf":""}` → bucket(恒为 "-1") → 指标 → 9 档边界。
   bucket 层保留是为了不破坏 video_metric_dist 的唯一键结构，实际全站每组只有一行。 */
export type MetricDists = Record<string, Record<string, Record<string, number[]>>>;

export function OnlinePlay({
  bvRanges,
  metricDists = {},
  player = null,
}: {
  bvRanges: BvRanges;
  metricDists?: MetricDists;
  /** 登录玩家（服务端注入）：仅用于「下载录像」文件名里的署名段；未登录为 null */
  player?: { id: number; name: string } | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  /* 结算面板里雷达组件的 React root（面板走 innerHTML 注入，只能这样挂 React 组件） */
  const radarRootRef = useRef<Root | null>(null);

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

    /* ---- 滑条填充自绘（张老师定稿：填充 #8ac21b + 滑块 #a6e22e）----
       初始写一遍 --pct；用户拖动走 input 委托（覆盖动态插入的滑条），
       程序赋值（applyZoom 等）在各赋值处单独补调 paintRangeFill */
    root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(paintRangeFill);
    on(root, "input", (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.type === "range") paintRangeFill(t);
    });

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
       无猜默认开（2026-10-15 张老师定）；localStorage 存过偏好的浏览器仍按存值恢复。
       二期起这些开关收进设置浮窗，初始值从 localStorage 恢复。
       「显示3BV」开关已废（2026-10-15 八期张老师定：状态栏整个取消，见 gname 注释） */
    let nf = false, ng = true, qmark = false;
    /* 「显示统计」开关（2026-10-15 六期张老师定，默认关）：左侧「数据统计」面板的**唯一**
       显示开关。八期改口径：开＝也只在**游戏结束**时随结算弹出（对局中不再常驻实时刷新
       ——张老师定「只有游戏结束才出现数据面板」）；关＝任何时刻都不显示。再开局撤下。 */
    let showStats = false;
    /* 无猜重排生效次数（踩一次雷/一个盲点算一次，内部重试不算）。
       状态栏取消后无 UI 消费，仅保留给 dev 测试钩子（__op.ngRedeals）验证重排逻辑 */
    let ngRedeals = 0;
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
          showStats?: boolean;
          lv?: string;
          cus?: { w: number; h: number; m: number };
        };
        if (typeof s.nf === "boolean") nf = s.nf;
        if (typeof s.ng === "boolean") ng = s.ng;
        if (typeof s.qmark === "boolean") qmark = s.qmark;
        if (typeof s.showStats === "boolean") showStats = s.showStats;
        /* 级别持久化（2026-10-14 四期张老师报：刷新/热更后回初级，设置浮窗的 3BV
           范围也跟着变初级区间，与玩家正在玩的级别脱节）——记住上次级别，开局恢复 */
        if (s.lv === "beg" || s.lv === "int" || s.lv === "exp" || s.lv === "cus") savedLv = s.lv;
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
        localStorage.setItem(LS_KEY, JSON.stringify({ nf, ng, qmark, showStats, lv, bv: bvSel, cus: cusSpec }));
      } catch { /* 隐私模式 */ }
    }
    /* 上次级别（loadSettings 恢复；无记忆/脏数据回落 beg） */
    let savedLv = "";
    loadSettings();
    let mines: Uint8Array | null = null, nums: Uint8Array | null = null;
    let state: Uint8Array = new Uint8Array(0); // 0=block 1=open 2=flag 3=question
    let started = false, over = false, startTs = 0, timerId: number | null = null;
    let openedSafe = 0, totalSafe = 0, board3bv = 0;
    let pressCell: number | null = null, chordCells: number[] | null = null, bothButtons = false;
    /* ---- 对局事件流（五期：回放/下载录像的数据源，AVF 口径）----
       mouse 码与 avf.ts 约定一致：1=mv 3=lc 5=lr 9=rc 17=rr 11=sc。
       像素坐标 = 格中心（x*16+8），与 rawvf 的 (px py) 同量纲；
       时间 = startTs 起的 (秒, 百分秒)，与计时器同源；首击（lc/lr）也在流里，
       且时间戳为 (0,0)——录像/回放从首击那一刻开始。 */
    let evStream: OnlineEvent[] = [];
    function evNow(): { sec: number; hun: number } {
      if (!started || !startTs) return { sec: 0, hun: 0 };
      const cs = Math.floor((performance.now() - startTs) / 10);
      return { sec: Math.floor(cs / 100), hun: cs % 100 };
    }
    function recordEv(mouse: number, i: number) {
      /* ⚠️ 这里**只**拦 over，不拦 !started（2026-10-15 六期修）：首击的 lc/lr 是在
         openCell 之前记录的（openCell 内部才把 started 置真、才布雷开表），
         若照旧要求 started，首击会被整条丢掉——回放进到从头那一刻会「什么都不开」，
         直到第二击才动（开局那一大片展开永远复现不出来）。
         started 为假时 evNow() 返回 (0,0)，正好就是首击该有的 t=0 时刻。 */
      if (over) return;
      const { sec, hun } = evNow();
      const x = (i % W) * 16 + 8, y = ((i / W) | 0) * 16 + 8;
      evStream.push({ mouse, x, y, sec, hun });
    }
    /* 鼠标移动事件（mv）：节流——与上次记录点距离 ≥4px 才记（2026-10-14 张老师定
       回放要顺滑：16px 降到 4px，密度×4；avf 事件流本来就走像素坐标，量级无压力）；
       坐标取实时鼠标位置换算的格中心（与点击事件对齐） */
    function recordMv(px: number, py: number) {
      if (!started || over || !evStream.length) return;
      const last = evStream[evStream.length - 1];
      if (Math.hypot(px - last.x, py - last.y) < 4) return;
      const { sec, hun } = evNow();
      evStream.push({ mouse: 1, x: px, y: py, sec, hun });
    }
    /* ---- 对局统计（结算报告用，口径与 flop player counters 一致，公式见其打包源码注释） ---- */
    let flagToggles = 0; // 插旗状态变化次数（配合 openedSafe 判断点击是否有效 Ce）
    let stLeft = 0, stRight = 0, stDouble = 0, stCe = 0, stPath = 0;
    let lastPX: number | null = null, lastPY = 0;
    let bvRegions: number[][] = []; // 空格连通域（含边界数字格）
    let bvSingles: number[] = []; // 非空格区的数字格（3BV 单击格）
    let bvIslands: number[][] = []; // singles 的八连连通域（岛屿）
    /* 计一次点击并按「棋盘是否有变化」累计有效点击 Ce（=Cl-浪费点击，flop 口径）；
       五期：同步写入事件流（lc/rc 双击语义按最终动作计） */
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
    const greport = $("greport");
    const gresult = $("gresult"); // 右侧结算面板（六期：雷达图 + 四按钮两行）
    /* ---- 七期（2026-10-15 张老师定）：移动端结算浮层 ----------------------------------
       <960px 时 CSS 里 .gresult.show 不生效（桌面右侧栏位放不下），完成一局改弹本浮层：
       全屏遮罩 + 屏幕居中卡片，点遮罩关闭。
       ⚠️ 必须挂 body 直下（同 #fs_tip）：#page 在 ≤605px 有整页 zoom，做在 #page 里的
          fixed 遮罩会随缩放失真、铺不满屏（本项目的既有教训）。
       断点与 CSS 的 (min-width: 960px) 必须同值——JS 按它决定把面板渲染到哪个宿主。 */
    const mqPanelDesktop = window.matchMedia("(min-width: 960px)");
    const grModal = document.createElement("div");
    grModal.id = "gr_modal";
    grModal.hidden = true;
    /* 卡片是个空壳：内容由 renderResultPanel 按当前断点填（另一端同步清空，
       保证 #gr_radar / 按钮 id 全文档只有一份） */
    grModal.innerHTML = '<div class="grm_card" id="grm_card"></div>';
    document.body.appendChild(grModal);
    const grmCard = grModal.querySelector("#grm_card") as HTMLElement;
    /* 记录面板当前在哪个宿主（resize 跨断点时用来判断要不要搬家） */
    let panelOnDesktop = mqPanelDesktop.matches;
    /* 点遮罩关闭（卡片内部点击的 e.target 是卡片或其子节点，不会命中） */
    on(grModal, "click", (e) => {
      if (e.target === grModal) hideResultModal();
    });

    /* ---- 结算快照（五期）：结束瞬间的完整对局状态，供重玩/回放/下载使用 ---- */
    interface GameSnapshot {
      w: number; h: number; m: number;
      mines: Uint8Array;
      bbbv: number;
      csec: number;           // 用时（百分秒）
      won: boolean;
      nf: boolean; ng: boolean; qmark: boolean;
      level: string;          // beg/int/exp/cus
      events: OnlineEvent[];
      dateStr: string;        // 对局时间（AVF 时间戳）
      stats: {
        solvedBv: number; cl: number; ce: number; stnb: number;
        bvs: number; ioe: number; corr: number; cls: number; ppc: number;
      };
    }
    let snapshot: GameSnapshot | null = null;

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
    /* 状态栏已整个取消（2026-10-15 八期张老师定：「没有意义」）——级别名与筛选 tabs 重复、
       3BV 有数据统计面板、NF/无猜是玩家自己开的开关。原 gname/gstatus 结构与
       updateStatus() 一并删除（对应 CSS 同步清理）。无猜重排计数（ngRedeals）保留给
       dev 测试钩子，见 openCell 里的 ++ngRedeals */
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
    /* 首击保护区：first 恒非雷；格子够多（除去 3×3 后仍放得下 M 颗雷）时连邻域一起保护 */
    function mineExclude(first: number): Uint8Array {
      const n = W * H;
      const ex = new Uint8Array(n);
      ex[first] = 1;
      const nb = neighbors(first);
      if (n - 1 - nb.length >= M) for (const c of nb) ex[c] = 1;
      return ex;
    }
    /* 全盘重算数字 + 3BV（爬山每次挪雷后都要跑一遍） */
    function recalcAll() {
      const n = W * H;
      const nn = new Uint8Array(n);
      for (let c = 0; c < n; c++) {
        if (mines![c]) continue;
        let cnt = 0;
        for (const a of neighbors(c)) if (mines![a]) cnt++;
        nn[c] = cnt;
      }
      nums = nn;
      compute3BV();
    }
    function placeMinesOnce(first: number, ex?: Uint8Array) {
      const e = ex || mineExclude(first);
      const n = W * H;
      const cand: number[] = [];
      for (let i = 0; i < n; i++) if (!e[i]) cand.push(i);
      mines = new Uint8Array(n); nums = new Uint8Array(n);
      for (let j = 0; j < M; j++) {
        const p = (Math.random() * (cand.length - j)) | 0;
        mines[cand[p]] = 1; cand[p] = cand[cand.length - 1 - j];
      }
      recalcAll();
    }
    /* 3BV 范围约束（2026-10-14 三修：随机重掷 → 单雷爬山）：
       ❗此前「重掷 300 次」对极窄范围近乎无效——初级 8×8·10 雷蒙特卡洛 10 万盘实测
       3BV≥40 的概率仅 0.036%，300 次重掷的命中率约 10%，玩家设 [40,51] 开局必出范围。
       现改为「一次随机撒雷 + 单雷爬山」：每轮随机挑一颗雷挪到随机空位，罚分下降即保留、
       否则回滚；长时间无进展就换一个随机盘重来。挪一颗雷只让 3BV 小幅漂移，
       靠几百步累积累计可达任意合法范围（实测 beg[40,51]、beg[2,12] 均稳定命中）。
       罚分＝区间外 1000+距离；区间内＝离区间中心的偏差×0.001（恒 <1），
       既保证「区间内永远优于区间外」，又留了向中心靠拢的余量
       （无猜重排会让 3BV 小幅漂移，贴边生成的盘一漂就出界）。
       完整统计区间（=原样）时完全跳过（零成本，与旧行为一致）。
       定稿的盘同时存 origMines——无猜重排的「贴原盘」锚点（见 noGuessOnce）。 */
    let origMines: Uint8Array | null = null;
    function placeMines(first: number) {
      /* 重玩本局（五期）：锁定盘直接注入——不随机、不筛 3BV、不爬山 */
      if (replayBoardLocked && pendingBoard && pendingBoard.length === W * H) {
        mines = pendingBoard.slice();
        const nn = new Uint8Array(W * H);
        for (let c = 0; c < W * H; c++) {
          if (mines[c]) continue;
          let cnt = 0;
          for (const a of neighbors(c)) if (mines[a]) cnt++;
          nn[c] = cnt;
        }
        nums = nn;
        compute3BV();
        origMines = mines.slice();
        replayBoardLocked = false; // 只吃一局；之后重开回随机
        pendingBoard = null;
        return;
      }
      const ex = mineExclude(first);
      placeMinesOnce(first, ex);
      if (!bvRangeFull()) {
        const sel = bvSel[lv], n = W * H;
        const mid = (sel.lo + sel.hi) / 2;
        const score = (v: number) =>
          (v < sel.lo ? 1000 + sel.lo - v : v > sel.hi ? 1000 + v - sel.hi : Math.abs(v - mid) * 0.001);
        const budget = Math.max(1000, Math.min(5000, Math.round(400000 / n)));
        let best = mines!.slice(), bestS = score(board3bv);
        let cur = bestS, stall = 0;
        for (let it = 0; it < budget && bestS >= 1000; it++) {
          const srcs: number[] = [], dsts: number[] = [];
          for (let i = 0; i < n; i++) {
            if (mines![i]) srcs.push(i);
            else if (!ex[i]) dsts.push(i);
          }
          const s = srcs[(Math.random() * srcs.length) | 0];
          const d = dsts[(Math.random() * dsts.length) | 0];
          mines![s] = 0; mines![d] = 1;
          recalcAll();
          const sc = score(board3bv);
          if (sc <= cur) {
            cur = sc;
            if (sc < bestS) { bestS = sc; best = mines!.slice(); stall = 0; }
            else if (++stall > 150) { placeMinesOnce(first, ex); cur = score(board3bv); stall = 0; }
          } else {
            mines![s] = 1; mines![d] = 0;
            recalcAll();
            if (++stall > 150) { placeMinesOnce(first, ex); cur = score(board3bv); stall = 0; }
          }
        }
        if (bestS < score(board3bv)) { mines = best; recalcAll(); }
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
        ngRedeals++; // 一次点击触发的无猜重排＝计数 1（内部重试不计）
      } else if (ng && nums![i] !== 0 && isBlind(i)) {
        const changed = tryNoGuess(i, true); // 安全盲点（数字格）：同样尽量换成 opening，盲点必开空
        if (changed) ngRedeals++;
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
    /* ---- 结算报告（2026-10-14 张老师定：游戏结束时桌面版左侧浮窗，再开局隐藏；
       2026-10-15 六期改：显示时机交给设置开关「显示统计」，见 showStats）。
       公式与 flop player counters 逐项对齐（摘自其打包源码注释）：
       Est=RT×(3BV/solved)；IOE=solved/Cl；ThrP=solved/Ce；Corr=Ce/Cl；
       RQP=Est×(Est+1)/3BV；QG=RT^1.7/solved；
       STNB=(87.420L²−155.829L+115.708)/QG×(solved/3BV)^0.5（L: beg=1/int=2/exp=3）；
       RTime 后缀 (n)=floor(RT)+1（录像秒数口径） */
    /* 表格 HTML + 完成 3BV（六期从 report 抽出：与结算共用同一份构造，口径永不分叉。
       八期起只在游戏结束这一刻渲染一次，不再有对局中刷新路径） */
    function statsReport(t: number): { solvedBv: number; html: string } {
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
      const html =
        '<div class="gr_title">数据统计</div>' +
        "<table>" +
        rows
          .map(
            (r) =>
              '<tr><td class="gt">' + r[0] + '</td><td class="gv">' + r[1] + '<span class="tip">' + r[2] + "</span></td></tr>"
          )
          .join("") +
        "</table>";
      return { solvedBv, html };
    }
    /* 写内容 → 显形 → 同步缩放/定位。顺序不可颠倒：display:none 期间量出的 rect 为 0，
       syncReportZoom 会因 rawW < 1 直接早退（面板位置/缩放就定格在旧值上） */
    function paintStatPanel(html: string) {
      greport.innerHTML = html;
      greport.classList.add("show");
      syncReportZoom();
    }
    function report(t: number, won: boolean) {
      const { solvedBv, html } = statsReport(t);
      /* 数据面板只在「显示统计」开着时、且只在**游戏结束**这一刻出现
         （2026-10-15 八期张老师定：对局中不再常驻实时刷新）；再开局由 reset 撤下 */
      if (showStats) paintStatPanel(html);
      buildResultPanel(t, solvedBv, won);
    }
    /* ---- 右侧结算面板（五期）：雷达图 + 再来一局 / 重玩本局 / 查看回放 / 下载录像 ---- */
    function buildResultPanel(t: number, solvedBv: number, won: boolean) {
      const cl = stLeft + stRight + stDouble, ce = stCe;
      const hasBv = solvedBv > 0 && t > 0;
      const qg = hasBv ? Math.pow(t, 1.7) / solvedBv : 0;
      const ln = lv === "beg" ? 1 : lv === "int" ? 2 : 3;
      const stnb = hasBv && lv !== "cus"
        ? (87.420 * ln * ln - 155.829 * ln + 115.708) / qg * Math.sqrt(solvedBv / board3bv)
        : 0;
      snapshot = {
        w: W, h: H, m: M,
        mines: mines ? mines.slice() : new Uint8Array(0),
        bbbv: board3bv,
        csec: Math.round(t * 100),
        won,
        nf, ng, qmark,
        level: lv,
        events: evStream.slice(),
        dateStr: formatAvfTimestamp(new Date()),
        stats: {
          solvedBv, cl, ce, stnb,
          bvs: hasBv ? solvedBv / t : 0,
          ioe: cl > 0 ? solvedBv / cl : 0,
          corr: cl > 0 ? ce / cl : 0,
          cls: t > 0 ? cl / t : 0,
          ppc: cl > 0 ? Math.round(stPath) / cl : 0,
        },
      };
      renderResultPanel();
    }
    function renderResultPanel() {
      if (!snapshot) return;
      const s = snapshot;
      /* 面板是 innerHTML 流：重设前先卸掉上一次挂载的雷达 React root，
         否则旧 root 的 DOM 会被 innerHTML 抽走、留下悬空引用 */
      radarRootRef.current?.unmount();
      radarRootRef.current = null;
      /* 标题行（七期 2026-10-15 张老师定）：**不再报「完成！/ 踩雷」**（笑脸状态已足够），
         左＝本局成绩（与录像详情页 h1 同格式同配色：级别名 + 级别色成绩 + NF）；
         八期追补：**踩雷局左侧显示灰色「未完成」**（失败的用时没有展示意义）。
         右＝「评级：S+」——五围图各轴组内分位的加权新评级（STNB 占一半、四分项各 1/8，
         权值见 lib/videoscore.ts PERFORMANCE_WEIGHTS）。
         雷达不可用（自定义盘 / 缺基准 / 完成度过低）时评级显示「—」 */
      const pts = computeRadarPoints(s);
      const percents: Partial<Record<MetricKey, number>> = {};
      for (const p of pts ?? []) percents[p.key] = p.percent;
      const perfGrade = pts ? gradeFromPercent(performanceOf(percents)) : "?";
      const lvName = (LEVEL_NAMES as Record<string, string>)[s.level] ?? "自定义";
      const lvSpan = s.won
        ? '<span class="gr_lv">' +
          lvName +
          '<em class="lv_' + s.level + '">' + (s.csec / 100).toFixed(2) + "</em>秒" +
          (s.nf ? "<ins>NF</ins>" : "") +
          "</span>"
        : '<span class="gr_lv fail">未完成</span>';
      const titleLine =
        '<div class="gr_title">' +
        lvSpan +
        '<span class="gr_rate">评级：<b style="color:' + gradeColor(perfGrade) + '">' +
        (perfGrade === "?" ? "—" : perfGrade) +
        "</b></span>" +
        "</div>";
      /* 按钮矢量图形（16px stroke 线性图标，与齿轮/全屏按钮同风格） */
      const IC = {
        /* 再来一局＝掷骰子（随机新盘面），与「重玩本局」的回转箭头形成对照 */
        newGame:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="none" stroke="currentColor" stroke-width="2" x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor"/></svg>',
        replaySame:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12a9 9 0 1 0 2.6-6.4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 4v5h5"/></svg>',
        review:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
        download:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m7 10 5 5 5-5"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 15V3"/></svg>',
      };
      /* 宿主按当前断点选（七期）：桌面＝右侧浮窗 gresult，移动＝居中浮层卡片 grmCard。
         非活动端同步清空——#gr_radar 与按钮 id 全文档只能存在一份 */
      const host = mqPanelDesktop.matches ? gresult : grmCard;
      (mqPanelDesktop.matches ? grmCard : gresult).innerHTML = "";
      /* 四个按钮分两行（2026-10-15 六期张老师定）：上排＝开局类（再来一局 / 重玩本局），
         下排＝本局录像类（查看回放 / 下载录像）。.gr_btns 走 2 列 grid，DOM 顺序即行列顺序 */
      host.innerHTML =
        titleLine +
        '<div class="gr_radar" id="gr_radar"></div>' +
        '<div class="gr_btns">' +
        '<button type="button" class="grb" id="grb_new_game">' + IC.newGame + "再来一局</button>" +
        '<button type="button" class="grb" id="grb_replay_same">' + IC.replaySame + "重玩本局</button>" +
        '<button type="button" class="grb" id="grb_review">' + IC.review + "查看回放</button>" +
        '<button type="button" class="grb" id="grb_download">' + IC.download + "下载录像</button>" +
        "</div>";
      /* 桌面：右侧浮窗显形（left/top/zoom 由 syncReportZoom 定位）；移动：弹遮罩浮层 */
      gresult.classList.toggle("show", mqPanelDesktop.matches);
      grModal.hidden = mqPanelDesktop.matches;
      /* 雷达图：标准级别才有基准分布；cus 盘/失败局/无基准 → 只显示数值不评级 */
      const radarHost = host.querySelector("#gr_radar") as HTMLElement | null;
      if (radarHost) {
        if (pts) {
          radarHost.style.display = "block";
          /* 复用录像详情页的 VideoAnalysisRadar 组件（张老师 2026-10-14 定：不该再维护第二份
             绘制）。面板是 innerHTML 注入流、JSX 挂不进去，所以用 createRoot 把 React 组件挂到
             占位 div —— 文案/字号/气泡样式与录像页**由同一个组件保证同源**，不会再分叉。
             fill 模式（八期 2026-10-15 张老师定）：宽度顶满面板内容宽，不再给固定边长 */
          const root = createRoot(radarHost);
          root.render(<VideoAnalysisRadar data={pts} fill />);
          radarRootRef.current = root;
        } else {
          radarHost.style.display = "none";
        }
      }
      const bind = (id: string, fn: () => void) => {
        const el = host.querySelector("#" + id) as HTMLElement | null;
        if (el) on(el, "click", fn);
      };
      bind("grb_new_game", newGame);
      bind("grb_replay_same", replaySameBoard);
      bind("grb_review", startInPlaceReplay);
      bind("grb_download", downloadAvf);
    }
    /* 移动端结算浮层收起 / 再弹（七期 2026-10-15 张老师定）。
       收起**不清内容**——只是 hidden，再弹不必重建（雷达 React root 留在卡片里，
       hidden 期间不响应 hover，无副作用；真正清空发生在 renderResultPanel 换宿主时） */
    function hideResultModal() {
      grModal.hidden = true;
    }
    function showResultModal() {
      /* 桌面端右侧浮窗常驻可见，没有「再弹」这回事；浮层只在移动端存在 */
      if (mqPanelDesktop.matches || !snapshot) return;
      grModal.hidden = false;
    }
    /* 雷达分位计算：基准由服务端注入（video_metric_dist 全表），分组只按「级别 × 模式」——
       全站恒 6 行，bucket 一律 DIST_BUCKET_ALL（张老师 2026-10-14 定：不细分 3BV、
       不同级别不通比）。缺组 → 返回 null（不显示雷达，只显示按钮）。
       完成度 < 10%（solvedBv/bbbv）不评级（2026-10-14 张老师定）：全部维度 grade="?"、
       percent=0，雷达图收缩成中心点——开局即死的局没有评价意义。
       ⚠️ 口径与录像详情页**完全同源**：五围 + 综合=四轴百分位加权，全部走 lib/videoscore.ts，
          不要在这里再写一份（2026-10-14 之前这里有本地副本，主模块改了副本没跟上，两边评级分叉） */
    function computeRadarPoints(s: GameSnapshot): VideoAnalysisPoint[] | null {
      if (s.level === "cus" || !s.stats.cl) return null;
      const dists = metricDists[s.level + (s.nf ? "_nf" : "")];
      const group = dists?.[String(DIST_BUCKET_ALL)];
      if (!group) return null;
      const lowCompletion = s.bbbv <= 0 || s.stats.solvedBv / s.bbbv < 0.1;
      /* ① 四根分项轴 */
      const subs: VideoAnalysisPoint[] = AXIS_METRICS.map((def) => {
        const value = s.stats[def.key];
        const dist = group[def.key] ?? [];
        const percent = dist.length ? percentOf(value, dist, def.highIsBetter) : 0;
        return {
          key: def.key,
          name: def.name,
          value,
          disp: formatMetric(def.key, value),
          percent,
          grade: dist.length ? gradeOf(value, dist, def.highIsBetter) : "?",
        };
      });
      /* ② 综合轴置顶：STNB 原值 + 组内分位（与录像详情页同源，张老师 2026-10-14 晚定） */
      const stnbValue = s.stats.stnb;
      const stnbDist = group["stnb"] ?? [];
      const composite: VideoAnalysisPoint = {
        key: "stnb",
        name: "综合",
        value: stnbValue,
        disp: formatMetric("stnb", stnbValue),
        percent: stnbDist.length ? percentOf(stnbValue, stnbDist, true) : 0,
        grade: stnbDist.length ? gradeOf(stnbValue, stnbDist, true) : "?",
      };
      if (lowCompletion) {
        return [composite, ...subs].map((p) => ({ ...p, disp: "—", percent: 0, grade: "?" }));
      }
      return [composite, ...subs];
    }
    /* AVF 时间戳格式（Arbiter 惯例）：M.D.YYYY.HH:MM:SS:mmmm */
    function formatAvfTimestamp(d: Date): string {
      const p2 = (n: number) => String(n).padStart(2, "0");
      return `${d.getMonth() + 1}.${d.getDate()}.${d.getFullYear()}.${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}:${String(d.getMilliseconds()).padStart(4, "0")}`;
    }
    /* ---- 重玩本局：完全复刻结束时的地图，强制关闭无猜（张老师定：重玩盘面必须原样） ---- */
    function replaySameBoard() {
      if (!snapshot) return;
      /* 无猜开关强制关闭（不影响设置浮窗的持久记忆——但本局内 ng 生效即关闭） */
      if (ng) {
        ng = false;
        swNg.checked = false;
        /* 不调 saveSettings：用户设置里的无猜偏好不被重玩按钮破坏？——但下一局 reset 用的是
           内存变量 ng（已 false），重玩期间无猜确实关闭；下次刷新恢复 localStorage 原值。
           张老师定的是「强制关闭无猜」，故本会话内从重玩起无猜关闭，直到用户再开 */
      }
      replayBoardLocked = true; // 标记：下一局布雷走锁定盘
      pendingBoard = snapshot.mines.slice();
      reset(lv === "cus" ? "cus" : lv);
    }
    /* ---- 再来一局（六期）：与「重玩本局」相对——全新随机盘面。必须显式清掉锁定标记，
       否则重玩本局之后再点再来一局，placeMines 仍会注入上一局的 pendingBoard ---- */
    function newGame() {
      replayBoardLocked = false;
      pendingBoard = null;
      reset(lv === "cus" ? "cus" : lv);
    }
    /* ---- 下载录像：标准 AVF 字节流 → Blob 下载 ---- */
    function downloadAvf() {
      if (!snapshot) return;
      const avf = buildOnlineAvf({
        width: snapshot.w,
        height: snapshot.h,
        mines: snapshot.m,
        board: snapshot.mines,
        questionMarks: snapshot.qmark,
        bbbv: snapshot.bbbv,
        scoreCsec: snapshot.csec,
        events: snapshot.events,
        timestamp: snapshot.dateStr,
      });
      const blob = new Blob([avf as unknown as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = onlineAvfFilename({
        level: snapshot.level,
        csec: snapshot.csec,
        nf: snapshot.nf,
        bbbv: snapshot.bbbv,
        user: player, // 未登录为 null → 文件名省略 `# 用户ID 英文名` 段
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    /* ---- 自研回放（五期二版，2026-10-14 张老师定：不弹窗，就在游戏界面进行；
       六期 2026-10-15 撤掉控制栏）----
       复用游戏本体盘面（VEC 管线 + vecUse），回放引擎重演事件流，进回放即自动播完。
       六期：回放中再点「查看回放」＝从头重播（此前是 early-return 点不动）；
       退出回放走 Esc / 笑脸 /「再来一局」/「重玩本局」，退出后恢复结算盘面。
       ⚠️ 回放期间必须屏蔽游戏交互（gboard 命中由 replaying 标志拦截），
       且不动引擎 state/mines——回放用自己的 rstate 副本驱动贴图。 */
    let replaying = false;
    /* 强制退出钩子：exitReplay 是闭包内的，reset（外层）够不着——由 startInPlaceReplay
       每次进入时注册，退出时自清；repaint 参数控制是否重画结算盘面（reset 路径不需要） */
    let forceExitReplay: (repaint?: boolean, restorePanel?: boolean) => void = () => {};
    /* 重播钩子（六期）：同一局回放中再点「查看回放」＝从头放。与 forceExitReplay 同理——
       restartReplay 也是闭包内的，由 startInPlaceReplay 注册、exitReplay 自清 */
    let restartReplay: (() => void) | null = null;
    function startInPlaceReplay() {
      if (!snapshot) return;
      /* 已在回放中（六期张老师定）：不忽略点击，从头重播 */
      if (replaying) { restartReplay?.(); return; }
      /* 移动端（七期）：回放在游戏盘面上演，结算浮层（带遮罩）挡着盘面——点「查看回放」
         即收起浮层，播完再弹回来（见 exitReplay / tick 的收尾） */
      hideResultModal();
      const s = snapshot;
      replaying = true;
      const N = s.w * s.h;
      /* 重建数字盘（快照雷区 → 数字），与引擎 recalcAll 同式 */
      const nums = new Uint8Array(N);
      const nbList: number[][] = [];
      const nbR = (i: number) => {
        if (nbList[i]) return nbList[i];
        const x = i % s.w, y = (i / s.w) | 0, r: number[] = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 >= 0 && nx2 < s.w && ny2 >= 0 && ny2 < s.h) r.push(ny2 * s.w + nx2);
        }
        nbList[i] = r; return r;
      };
      for (let c = 0; c < N; c++) {
        if (s.mines[c]) continue;
        let cnt = 0;
        for (const a of nbR(c)) if (s.mines[a]) cnt++;
        nums[c] = cnt;
      }
      /* 回放状态机（0=未开 1=开 2=旗），直接写游戏盘面贴图：
         td 类名走 VEC_MAP 语义（bb/b1…/bf），vecUse 同步切换——与引擎 paint 同管线 */
      const rstate = new Uint8Array(N);
      function paintR(i: number) {
        const td = tbody.rows[(i / s.w) | 0].cells[i % s.w];
        let cls = "bb";
        if (rstate[i] === 1) cls = "b" + nums[i];
        else if (rstate[i] === 2) cls = "bf";
        td.className = cls;
        td.innerHTML = "";
        vecUse[i]?.setAttribute("href", "#" + (VEC_MAP[cls] ?? ""));
      }
      function floodR(i: number) {
        const stack = [i];
        while (stack.length) {
          const c = stack.pop()!;
          if (rstate[c] === 1 || rstate[c] === 2 || s.mines[c]) continue;
          rstate[c] = 1; paintR(c);
          if (nums[c] === 0) for (const a of nbR(c)) if (rstate[a] === 0) stack.push(a);
        }
      }
      function chordR(i: number) {
        if (rstate[i] !== 1 || nums[i] === 0) return;
        const around = nbR(i);
        let fc = 0;
        for (const a of around) if (rstate[a] === 2) fc++;
        if (fc !== nums[i]) return;
        for (const a of around) if (rstate[a] === 0) floodR(a);
      }
      const evs = s.events;
      /* 回放光标：flopplayer 同款鼠标箭头（cursor-arrow 贴图，FlopSprites 已内置）。
         箭头坐标域 0-120 × 0-190、尖端在 (5,12)——事件像素坐标 (e.x,e.y) 对准尖端：
         容器左上角偏移 (-5,-12)，渲染尺寸 12×19（一格量级，flop 原版视觉） */
      const curEl = document.createElement("div");
      curEl.className = "replay_cursor";
      curEl.innerHTML = '<svg viewBox="0 0 120 190" width="12" height="19" aria-hidden="true"><use href="#cursor-arrow" /></svg>';
      /* 挂 .gwrap（不是 gboard）：gwrap 的 zoom 让光标随整窗缩放；z-index 压过
       计数条/笑脸（2026-10-14 张老师报：光标被笑脸层挡住）。
       坐标换算：事件像素是 gboard 1x 坐标 → gwrap 局部坐标需加 gboard 相对
       gwrap 的静态偏移（gwrap padding 9 + border 3 + gbar 高 + margin 9——
       运行时一次量取，zoom 体系内 gboard 原点即偏移值，不随倍率变） */
      gwrap.appendChild(curEl);
      const gboardOff = (() => {
        const gb = gboard.getBoundingClientRect();
        const gw = gwrap.getBoundingClientRect();
        const z = (parseFloat(gwrap.style.zoom) || 1) * pageZoom();
        return { x: (gb.left - gw.left) / z, y: (gb.top - gw.top) / z };
      })();
      /* 尖端锚点：箭头 (5,12) 对准事件坐标——left/top 直接写偏移后的值
         （1x 像素坐标系内偏移固定；CSS margin 在 zoom 下的缩放语义不可靠，弃用） */
      const TIP_X = 5, TIP_Y = 12;
      function moveCursor(px: number, py: number) {
        curEl.style.left = px + gboardOff.x - TIP_X + "px";
        curEl.style.top = py + gboardOff.y - TIP_Y + "px";
      }
      function applyEv(k: number) {
        const e = evs[k];
        moveCursor(e.x, e.y);
        const ci = ((e.y / 16) | 0) * s.w + ((e.x / 16) | 0);
        if (ci < 0 || ci >= N) return;
        if (e.mouse === 3) {
          if (rstate[ci] === 0) floodR(ci);
          else if (rstate[ci] === 1) chordR(ci);
        } else if (e.mouse === 11) {
          chordR(ci);
        } else if (e.mouse === 9) {
          if (rstate[ci] === 0) { rstate[ci] = 2; paintR(ci); }
          else if (rstate[ci] === 2) { rstate[ci] = 0; paintR(ci); }
        }
      }
      /* 六期（2026-10-15 张老师定）：**不再插控制条**——原 rc_* 控制栏（重放/播放暂停/
         速度/进度/退出）整条撤掉；进回放即自动播完（固定 1x），回放中再点「查看回放」
         ＝从头重播，退出走 Esc / 笑脸 /「再来一局」/「重玩本局」（后两者经 reset 的
         forceExitReplay）。 */
      let evIdx = 0;
      let curCsec = 0;
      let playing = false;
      let rafId: number | null = null;
      let lastFrame = 0;

      function setPlaying(v: boolean) {
        playing = v;
        if (playing) {
          if (curCsec >= s.csec) seekTo(0);
          lastFrame = 0;
          rafId = requestAnimationFrame(tick);
        } else if (rafId !== null) {
          cancelAnimationFrame(rafId); rafId = null;
        }
      }
      function resetReplay() {
        rstate.fill(0);
        for (let i = 0; i < N; i++) paintR(i);
        evIdx = 0; curCsec = 0;
        moveCursor(0, 0);
      }
      function seekTo(csec: number) {
        resetReplay();
        const target = Math.max(0, Math.min(s.csec, csec));
        while (evIdx < evs.length) {
          const e = evs[evIdx];
          if (e.sec * 100 + e.hun > target) break;
          applyEv(evIdx);
          evIdx++;
        }
        curCsec = target;
        interpCursor(target);
      }
      /* 光标插值（2026-10-14 张老师报回放一顿一顿）：时间轴推进的每帧，光标在
         「最近已应用事件」与「下一事件」之间按时间线性补间——即使两个 mv 间隔
         较长（或点击后停顿），光标也连续滑动而非跳变。棋盘事件照旧离散应用。 */
      function interpCursor(csec: number) {
        const prev = evIdx > 0 ? evs[evIdx - 1] : null;
        const next = evIdx < evs.length ? evs[evIdx] : null;
        if (!prev) { if (next) moveCursor(next.x, next.y); return; }
        const pT = prev.sec * 100 + prev.hun;
        if (!next) { moveCursor(prev.x, prev.y); return; }
        const nT = next.sec * 100 + next.hun;
        const t = nT > pT ? Math.max(0, Math.min(1, (csec - pT) / (nT - pT))) : 1;
        moveCursor(prev.x + (next.x - prev.x) * t, prev.y + (next.y - prev.y) * t);
      }
      function tick(ts: number) {
        if (!playing) return;
        /* 速度恒 1x（六期撤掉控制条后已无倍速入口） */
        const dt = lastFrame ? (ts - lastFrame) / 10 : 0;
        lastFrame = ts;
        const target = Math.min(s.csec, curCsec + dt);
        while (evIdx < evs.length) {
          const e = evs[evIdx];
          if (e.sec * 100 + e.hun > target) break;
          applyEv(evIdx);
          evIdx++;
        }
        curCsec = target;
        interpCursor(target);
        if (target >= s.csec) {
          setPlaying(false);
          /* 移动端（七期 2026-10-15 张老师定：回放播放完后再次显示浮层）：
             浮层是带遮罩的全屏层，回放停在原地会被它盖住、连退出入口都摸不到——
             播完直接退出回放（恢复结算盘面）并重新弹出「本局表现」浮层。
             桌面端浮窗本来就在盘面旁常驻，保持原样（回放停在终局画面）。 */
          if (!mqPanelDesktop.matches) exitReplay();
          return;
        }
        rafId = requestAnimationFrame(tick);
      }
      /* restorePanel（七期）：退出回放后是否把「本局表现」浮层弹回来。
         reset 路径（新开一局 / 再来一局 / 重玩本局）传 false——那时浮层必须收着 */
      function exitReplay(repaint = true, restorePanel = true) {
        setPlaying(false);
        replaying = false;
        restartReplay = null;
        curEl.remove();
        /* 恢复结算盘面（repaintAll 按引擎 state 重画，含败局雷区揭示）；
           reset 路径传 false（后面自会全盘重画） */
        if (repaint) repaintAll();
        document.removeEventListener("keydown", escR);
        if (restorePanel) showResultModal();
      }
      /* 注册给外层用（进回放时更新引用，退出时自清）：
         forceExitReplay 供 reset 强制退出；restartReplay 供回放中再点「查看回放」从头重播 */
      forceExitReplay = exitReplay;
      restartReplay = () => { setPlaying(false); resetReplay(); setPlaying(true); };
      function escR(e: KeyboardEvent) {
        if (e.key === "Escape" && replaying) exitReplay();
      }
      document.addEventListener("keydown", escR);
      resetReplay();
      setPlaying(true); // 进入即自动播放（复位到 0 起播）
    }
    function lose(hit: number) {
      over = true;
      const t = stopTimer();
      report(t, false); // 雷区揭示不影响统计（区域/单子只含非雷格，旗帜格不动）；败局快照在揭示前定格
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
      report(t, true); // 须在自动补旗之前：Flags 只算玩家实际插的
      for (let i = 0; i < mines!.length; i++) if (mines![i] && state[i] !== 2) { state[i] = 2; paint(i); }
      led(ledMines, 0);
      setFace("win");
      /* 胜利同样不再有任何文字提醒（数据都在左侧报告浮窗里） */
    }
    function reset(level?: string) {
      /* 回放中重开（笑脸/F2/切级别）：先强制退出回放，清掉光标/拦截标志
         （2026-10-14 张老师报：播放回放后点笑脸不能再玩——回放元素残留锁死游戏）。
         exitReplay 的 repaintAll 在这里跳过：reset 后面自会全盘重画。
         第二个参数 false（七期）：新开一局不许把「本局表现」浮层弹回来 */
      if (replaying) forceExitReplay(false, false);
      const prevLv = lv, prevW = W, prevH = H;
      lv = level || lv;
      const L = levelSize(lv); W = L.x; H = L.y; M = L.m;
      mines = null; nums = null; state = new Uint8Array(W * H);
      started = false; over = false; openedSafe = 0; totalSafe = W * H - M; board3bv = 0;
      /* 统计清零 + 隐藏结算报告（张老师：游戏再次开始时隐藏）；事件流同步清空
         （五期）；重玩锁定标记保留——placeMines 在首击时消费它 */
      flagToggles = 0; stLeft = 0; stRight = 0; stDouble = 0; stCe = 0; stPath = 0; lastPX = null;
      evStream = [];
      /* 数据面板（八期）：任何时刻都不因开局而显示——只有游戏结束且开关开着才弹出
         （见 report）。statsReport 只读 state/统计量、不读 snapshot，
         故与下面 snapshot = null 的先后无依赖 */
      greport.classList.remove("show");
      gresult.classList.remove("show");
      hideResultModal(); // 移动端浮层（七期）随新局一并收起
      snapshot = null;
      stopTimer();
      led(ledMines, M); led(ledTime, 0);
      setFace("smile");
      ngRedeals = 0;
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
      /* 级别变更即持久化（四期）：否则切级别后不碰其他设置就刷新，仍会回旧级别 */
      if (lv !== prevLv) saveSettings();
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
      /* 级别切换后浮窗 3BV 滑杆范围联动（浮窗开着时立即刷新） */
      syncBvSlider();
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
      /* 主体板块宽度自适应（v7）：必须放在上面 zoom 之后——applyModeZoom/applyZoom
         已把 zoomWant 更新成目标模式的记忆值，页宽按它算才准；拖动中函数自冻结 */
      syncPageFit();
      /* 数据面板常驻时（六期）重开后盘面尺寸/倍率可能已变，重新对齐+缩放 */
      if (showStats) syncReportZoom();
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
    /* 弹窗内的显示比例滑杆（v7 张老师 19:07：比例并入自定义弹窗，省得两个浮窗来回切）
       ——与设置浮窗的 #zoom_range 是同一份状态的两个视图，applyZoom 内统一同步 */
    const cusZoom = $("cus_zoom") as HTMLInputElement;
    const cusZoomVal = $("cus_zoom_val");
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
      if (cusVal(cusM) > cap) {
        cusM.value = String(cap);
        paintRangeFill(cusM); // 程序钳制雷数后同步填充比例
      }
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
    /* 版式拖动冻结（张老师 18:52 报「宽调回小值板块不缩」的根因）：
       页宽变化会让居中的 #page 左缘平移，弹窗滑轨跟着横移；range input 拖动中
       pointer capture 按轨道「当前位置」把同一点点位换算成值——值跳回大值 → 板块又扩，
       来回振荡，表现即「调回来了板块却不缩」。故拖动期间（cusDragging）冻结版式，
       松手（pointerup/change）时一次到位；点 tab 切级别 / F2 等非拖动 reset 照常即切。
       拖动中盘面超出当前页宽由 normalMaxZoom 自动缩兜底，松手后页宽跟上再回弹 */
    let cusDragging = false;
    /* 主体板块宽度自适应（三期 v7，2026-10-14 19:07 张老师定）：
       自定义盘按盘面渲染宽精算 #page 宽度（公式与量纲见文首 PAGE_PAD 注释），
       小盘不再在 960 板块里留一大片空档；标准级别清掉 inline 交回常规 80%/960 版式。
       仅桌面断点生效：≤768 的移动版 #page 有自己的整页 zoom + 固定布局宽体系，
       本函数直接让位（清 inline），不破坏移动版式。
       ⚠️ 2026-10-15：横屏沉浸模式也让位——横屏 #page 由 CSS 固定铺满视口
       （margin/padding 全清），页宽不再跟随盘面；否则 844 视口下宽 ≤828 的
       内联宽会在右侧留下一条露背景的空档，且与「严格占满 100%」冲突 */
    const mqDesktop = window.matchMedia("(min-width: 769px)");
    function syncPageFit() {
      const pe = pageEl as HTMLElement | null;
      if (!pe) return;
      if (lv !== "cus" || !mqDesktop.matches || lsQuery.matches) {
        pe.style.width = "";
        pe.style.maxWidth = "";
        return;
      }
      if (cusDragging) return; // 拖动中冻结（见上）
      const baseW = gframe.offsetWidth; // 布局宽＝基准宽（不含游戏 zoom，Chrome 实测）
      if (baseW < 8) return;
      const avail = window.innerWidth / pageZoom() - 16; // 可用视口宽（CSS px，左右各留 8）
      /* 页宽 = 盘面期望渲染宽 + PAGE_PAD。PAGE_PAD 比实际盒装损耗 GA_OFFSET 多 22px，
         故 normalMaxZoom 的宽度封顶恒 ≥ 期望倍率——「页宽跟随盘面」与「盘面按上限
         封顶」互相解耦，不会来回缩（封顶本身按视口算，不读页宽，见 normalMaxZoom） */
      const wantW = Math.max(PAGE_MIN_W, Math.min(baseW * zoomWant + PAGE_PAD, avail, PAGE_MAX_W));
      pe.style.width = Math.round(wantW) + "px";
      pe.style.maxWidth = Math.round(wantW) + "px";
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
        [cusW, cusH, cusM].forEach(paintRangeFill); // 程序回填后同步填充比例
        syncCusVals();
      }
      cusDlg.classList.add("open");
      if (lv !== "cus") reset("cus"); // 点自定义＝选定级别立即切盘（同点初级/高级语义）
      /* 比例滑杆回填当前倍率（v7）：与设置浮窗那张同源，开窗即显示实际值 */
      cusZoom.max = zoomRange.max;
      cusZoom.value = String(zoomCur);
      paintRangeFill(cusZoom);
      cusZoomVal.textContent = zoomCur.toFixed(2) + "x";
      positionCusDialog(); // 须在 reset 之后：tab 由 a 变 span.current 字重变了，宽度要重算
    }
    function closeCusDialog() { cusDlg.classList.remove("open"); }
    on(cusW, "input", () => { clampCusMines(); syncCusVals(); applyCusLive(); });
    on(cusH, "input", () => { clampCusMines(); syncCusVals(); applyCusLive(); });
    on(cusM, "input", () => { syncCusVals(); applyCusLive(); });
    /* 宽/高拖动期间冻结版式（cusDragging，见 syncPageFit 注释）。
       pointerup 与 change 双保险解冻：原地点击 thumb 值没变时 change 不触发，
       只靠 change 会把标志卡在 true、版式永远冻结。
       松手时页宽一次到位 + 弹窗重新对准（页宽变了 tab 位置也变） */
    function afterCusDrag() {
      cusDragging = false;
      syncPageFit();
      positionCusDialog();
    }
    on(cusW, "pointerdown", () => { cusDragging = true; });
    on(cusH, "pointerdown", () => { cusDragging = true; });
    on(cusW, "pointerup", afterCusDrag);
    on(cusH, "pointerup", afterCusDrag);
    on(cusW, "change", afterCusDrag);
    on(cusH, "change", afterCusDrag);
    /* 比例滑杆交互（弹窗内 v7 张老师 19:07 / 设置浮窗二期那张同源）：
       拖动中只改渲染倍率（setZoomVisual，不封顶不写盘）——页宽一变，居中板块里的
       滑轨就横移，range 会把同一点点位换算成别的值（v6 振荡同源），故拖动中页宽冻结；
       松手（pointerup/change，双保险：拖到端点值不变时 change 不触发）再由 applyZoom
       按视口上限正式定值 + 写记忆，随后页宽与弹窗锚位一次到位 */
    function zoomDragInput(v: number) {
      zoomBeforeFs = null; // 手动调比例 → 以手动为准，退出全屏/横屏不再自动恢复
      zoomBeforeLs = null;
      zoomWant = v;
      setZoomVisual(v);
    }
    function zoomDragEnd() {
      syncPageFit(); // 页宽按最终倍率到位
      applyZoom(zoomWant); // 按视口上限封顶 + 落盘
      positionCusDialog(); // 页宽变了 → 弹窗重新对准 tab
    }
    on(cusZoom, "input", () => zoomDragInput(parseFloat(cusZoom.value)));
    on(cusZoom, "pointerup", zoomDragEnd);
    on(cusZoom, "change", zoomDragEnd);
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
    const swStats = $("sw_stats") as HTMLInputElement;
    on(swNf, "change", () => {
      nf = swNf.checked;
      saveSettings();
      reset();
    });
    on(swNg, "change", () => {
      ng = swNg.checked;
      saveSettings();
      reset();
    });
    on(swQm, "change", () => { qmark = swQm.checked; saveSettings(); });
    /* 「显示统计」（八期改口径）：只影响**游戏结束**时是否弹出数据面板，不重开当前局。
       打开时对局中不提前出现；关闭时若上一局定格的面板还挂着，立刻撤下 */
    on(swStats, "change", () => {
      showStats = swStats.checked;
      saveSettings();
      if (!showStats) greport.classList.remove("show");
    });

    /* ---- 全屏按钮（图标按钮，点击在全屏/非全屏间切换） ----
       兼容退化（2026-10-14 张老师报：iPhone 上点了没反应）：
       iPhone Safari 不提供元素全屏 API（requestFullscreen 仅桌面/iPad 有），
       系统地址栏属浏览器 UI、网页无法隐藏——点按钮改弹「添加到主屏幕」引导
       （fsTip，iOS 唯一真全屏途径：Safari 添加主屏幕后 standalone 打开，
       layout.tsx appleWebApp）；已是主屏幕图标打开的（standalone，本就无地址栏）
       不弹引导，直接进伪全屏：html.op-fakefs 隐藏站头与页顶留白并回顶。
       其他无全屏 API 的浏览器（部分安卓内嵌）同样走伪全屏 */
    const fsSupported = typeof root.requestFullscreen === "function";
    let fakeFs = false;
    /* 伪全屏开关（仅无元素全屏 API 的环境用） */
    function setFakeFs(on: boolean) {
      fakeFs = on;
      document.documentElement.classList.toggle("op-fakefs", fakeFs);
      fsBtn.classList.toggle("active", fakeFs);
      fsBtn.title = fakeFs ? "退出全屏" : "全屏";
      if (fakeFs) window.scrollTo(0, 0); // 回顶：第一屏即游戏区
      if (lsQuery.matches) fitZoomForLandscape(); // 顶高变了按新视口重拉
      else applyZoom(zoomCur, false);
    }
    /* iOS 引导浮层（2026-10-14 张老师定）：挂 body 直下——放在 #page 里会被
       移动版的页级 zoom 连带缩放，fixed 遮罩铺不满屏 */
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+ 伪装成 Mac
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const fsTip = document.createElement("div");
    fsTip.id = "fs_tip";
    fsTip.hidden = true;
    fsTip.innerHTML =
      '<div class="fstip_card">' +
        '<div class="fstip_head">全屏玩法</div>' +
        '<p class="fstip_p">iPhone 上浏览器地址栏无法由网页隐藏。<b>添加到主屏幕</b>后从桌面图标打开，' +
        '才是全屏无地址栏的效果。</p>' +
        '<ol class="fstip_steps">' +
          '<li>用 <b>Safari</b> 打开本页（微信里可点右上角「⋯」→「在浏览器打开」）</li>' +
          '<li>点 Safari 工具栏的' +
            '<svg class="ico_share" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
            '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
            'stroke-linejoin="round" d="M12 15V3m0 0L8 7m4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />' +
            '</svg>分享按钮</li>' +
          '<li>选「添加到主屏幕」，回桌面点图标进入</li>' +
        '</ol>' +
        '<div class="fstip_btns">' +
          '<button type="button" id="fs_tip_fake">暂用大屏模式</button>' +
          '<button type="button" class="fstip_ok" id="fs_tip_ok">知道了</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(fsTip);
    const $tip = <T extends HTMLElement = HTMLElement>(id: string) =>
      fsTip.querySelector<T>(`#${id}`)!;
    const hideFsTip = () => { fsTip.hidden = true; };
    on($tip("fs_tip_ok"), "click", hideFsTip);
    on($tip("fs_tip_fake"), "click", () => { hideFsTip(); setFakeFs(true); });
    on(fsTip, "click", (e) => { if (e.target === fsTip) hideFsTip(); }); // 点卡片外空白关闭
    on(fsBtn, "click", () => {
      if (fsSupported) {
        if (document.fullscreenElement === root) document.exitFullscreen();
        else {
          const p = root.requestFullscreen();
          if (p && p.catch) p.catch(() => { /* 无手势被拒等：静默 */ });
        }
      } else if (isIOS && !isStandalone && !fakeFs) {
        fsTip.hidden = false; // iOS 非 standalone：引导添加到主屏幕（点了没用，先给途径）
      } else {
        setFakeFs(!fakeFs);
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
      syncPageFit(); // 自定义盘的页宽按新视口重算（非 cus 级别内部直接清 inline）
      /* 数据面板常驻时（六期）：跟随 gwrap 重新贴合（内部对未显示的面板直接早退） */
      syncReportZoom();
      /* 断点跨越（七期）：宽屏 ↔ 窄屏互切后，已结束那局的结算面板搬到对应宿主
         （桌面右侧浮窗 / 移动居中浮层）——否则窄屏下面板会留在看不见的 gresult 里 */
      if (snapshot && mqPanelDesktop.matches !== panelOnDesktop) {
        panelOnDesktop = mqPanelDesktop.matches;
        renderResultPanel();
      }
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
    /* 回放期间游戏盘不吃任何鼠标交互（F2/R 重开也拦，避免回放中被清盘） */
    const gameBusy = () => replaying;
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
      if (over || gameBusy()) return;
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
      if (over || gameBusy()) return;
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
      if (over || gameBusy()) { clearPress(); return; }
      const i = eventCell(e); clearPress(); setFace("smile");
      if (i < 0) { bothButtons = false; return; }
      if (e.button === 0) {
        if (bothButtons) { bothButtons = false; recordEv(11, i); action("double", () => chord(i)); }
        else if (state[i] === 1) { recordEv(3, i); action("left", () => chord(i)); } // 单击已满足的数字同效
        else { recordEv(3, i); action("left", () => openCell(i)); recordEv(5, i); }
      } else if (e.button === 2) {
        /* 右键释放也进事件流（rr）——rc/rr 配对与 avf 口径一致 */
        recordEv(9, i); recordEv(17, i);
      }
    });
    on(gboard, "mouseleave", () => { clearPress(); if (!over) setFace("smile"); lastPX = null; });
    /* Path：对局中鼠标在棋盘上的欧氏行程，归一化到 1x 棋盘像素（除以游戏倍率与页级缩放）；
       五期：同一路径上记录 mv 事件（节流 ≥16px，recordMv 内控） */
    on(gboard, "mousemove", (e: MouseEvent) => {
      if (started && !over) {
        if (lastPX !== null) {
          stPath += Math.hypot(e.clientX - lastPX, e.clientY - lastPY) / (zoomCur * pageZoom());
        }
        lastPX = e.clientX; lastPY = e.clientY;
        /* mv 像素坐标：屏幕坐标 → 棋盘 1x 像素（除以倍率与页级缩放，再减棋盘原点） */
        const gbR = gboard.getBoundingClientRect();
        recordMv(
          Math.max(0, (e.clientX - gbR.left) / (zoomCur * pageZoom())),
          Math.max(0, (e.clientY - gbR.top) / (zoomCur * pageZoom())),
        );
      }
    });

    /* ---- 触屏交互（2026-10-14 张老师定）：点按开格 / 长按 ≥150ms 插旗 /
       插旗后自动对邻近所有已开数字格执行双击（chord）。「插旗模式」按钮已废——
       移动端插旗只走长按 ---- */
    let touchTimer: number | null = null, touchCell = -1, longFired = false;
    let touchX = 0, touchY = 0; // 起点坐标：滑动容差判定用
    on(gboard, "touchend", (e: TouchEvent) => {
      if (touchTimer) clearTimeout(touchTimer);
      if (touchCell >= 0 && !over && !longFired) {
        if (state[touchCell] === 1) { recordEv(3, touchCell); action("left", () => chord(touchCell)); }
        else { recordEv(3, touchCell); action("left", () => openCell(touchCell)); recordEv(5, touchCell); }
      }
      touchCell = -1;
      e.preventDefault();
    }, { passive: false });
    /* 滑动取消带 12px 容差：手指微颤（1-2px）不再吞掉点按——「有时点击无效」
       的主因就是原实现 touchmove 一动即取消（2026-10-14 张老师报） */
    on(gboard, "touchmove", (e: TouchEvent) => {
      if (touchCell < 0) return;
      const t = e.changedTouches[0];
      if (t && Math.hypot(t.clientX - touchX, t.clientY - touchY) > 12) {
        if (touchTimer) clearTimeout(touchTimer);
        touchCell = -1;
      }
    }, { passive: true });
    on(gboard, "touchstart", (e: TouchEvent) => {
      const t = e.changedTouches[0]; if (!t) return;
      const i = eventCell(t); if (i < 0 || over) return;
      touchCell = i; longFired = false;
      touchX = t.clientX; touchY = t.clientY;
      touchTimer = window.setTimeout(() => {
        longFired = true;
        if (state[i] === 1) return; // 已开格长按无意义
        recordEv(9, i); recordEv(17, i); action("right", () => toggleFlag(i));
        if (navigator.vibrate) navigator.vibrate(30);
        /* 插旗后自动对邻近所有已开数字格执行双击（张老师定）：移动端没有
           右键/双击，靠这一步补齐「标完旗顺手开满足格」的操作链。
           chord 内部自会校验旗数是否满足，不满足时天然空操作 */
        for (const a of neighbors(i)) {
          if (over || state[a] !== 1 || !nums || nums[a] === 0) continue;
          recordEv(11, a); action("double", () => chord(a));
        }
      }, 150);
      e.preventDefault();
    }, { passive: false });

    /* ---- 缩放控制条（复刻 flop player 1.00x 滑杆） ---- */
    const gframe = $("gframe");
    /* 游戏窗容器（计数条+棋盘+状态栏的银灰外框）——zoom 挂这一层（2026-10-14 张老师定：
       整窗同比例缩放）。greport/gresult 已挪出 gwrap（挂 #game_area），不受 zoom 连带 */
    const gwrap = root.querySelector<HTMLElement>(".gwrap")!;
    const zoomRange = $("zoom_range") as HTMLInputElement;
    const zoomVal = $("zoom_val");
    let zoomCur = 1; // 当前游戏倍率（不含整页窄屏缩放）
    let zoomWant = 1; // 玩家期望倍率（applyZoom 入参、clamp 前）——自适应页宽按它算（v7）
    const lsQuery = window.matchMedia("(orientation: landscape) and (max-height: 520px)"); // 横屏拉满断点（声明须在 applyZoom 之前，normalMaxZoom 会读它）
    let zoomBeforeFs: number | null = null; // 进全屏前的倍率；全屏中手动调过则置 null 不再恢复
    /* 普通模式倍率上限：游戏渲染宽不得超过容器宽，否则冲出 #page 版块。
       用 getBoundingClientRect 实测自校准：gfR.width = 基准宽 × zoomCur × 所有祖先
       zoom，gaR.width = 容器宽 × 同一祖先 zoom——比值里 zoom 全部抵消，任意页级
       缩放/窄屏断点下都成立。全屏/横屏由 fitZoom* 拉满（max=5），不走此封顶。
       自定义盘（三期 v7）两处不同：
       ① 宽度封顶按「视口 / 扩版上限」算，**不按当前容器**——自定义盘的页宽本身
          跟着盘面走（syncPageFit），若再按当前容器封顶，两个公式会互相压制：
          盘面永远只能填满当前页宽 → 比例调不大、松手后板块比盘面宽留空档；
       ② 额外加高度封顶：常规三级盘高度有限（≤16 行）从不需要，自定义最高 99 行
          会被视口下方内容推出去——按「视口底到游戏区顶的可用高」反算倍率，
          与宽度方向取小，保证整个盘面完整可见不裁切 */
    function normalMaxZoom() {
      if (document.fullscreenElement === root) return 5;
      const gfR = gframe.getBoundingClientRect();
      const gaR = ($("game_area") as HTMLElement).getBoundingClientRect();
      if (gfR.width <= 0 || gaR.width <= 0) return 2.5;
      /* 下限 0.5（=滑杆 min）：窄窗连 1x 都放不下时按容器宽自动缩，保证不溢出。
         自定义大盘（cus）额外放宽到 0.3——99 宽盘即使页宽已按视口放宽
         仍可能超容器，需要更小的自动缩下限才能完整可见 */
      const zMin = lv === "cus" ? 0.3 : 0.5;
      let cap: number;
      if (lsQuery.matches) {
        /* 横屏沉浸（判定提到最前，2026-10-15 二定「严格占满 100%」）：
           横屏一律按可视视口封顶，**不再区分 cus/标准**——cus 分支的基准是
           window.innerWidth（超宽盘撑爆布局视口时会被放大到 1047 之类），
           会允许盘面宽过真实屏宽 → 被 body overflow:hidden 裁掉。走这里也顺带
           兜底「首帧超宽盘撑爆」：高级盘默认 1.71x = 830px > 屏宽，一旦撑爆
           innerWidth/innerHeight 与 rect 全部失真（2026-10-14 张老师报：高级盘
           横屏高度不对的根因），visualViewport 不受影响。
           扣除量只剩 box 左右边框（LS_RESERVE_W=2） */
        const vv = window.visualViewport;
        const vw = (vv ? vv.width : window.innerWidth) / pageZoom();
        cap = (vw - LS_RESERVE_W) / gwrap.offsetWidth;
      } else if (lv === "cus") {
        const baseW = gframe.offsetWidth || gfR.width / zoomCur; // 基准宽（不含游戏 zoom）
        const limitW = Math.min(window.innerWidth / pageZoom(), PAGE_MAX_W) - GA_OFFSET - 16;
        cap = limitW / baseW;
        /* 高度方向：gfR.height 是渲染高（含 zoomCur×pz），约束
           base_h × zoom × pz ≤ 可用高（视口像素）→ hCap = zoomCur×可用高/gfR.height。
           可用高 = 视口底 − game_area 顶 − 底部余量 12px（页脚仍可滚动，正常） */
        const availH = window.innerHeight - gaR.top - 12;
        if (gfR.height > 0 && availH > 0) cap = Math.min(cap, (zoomCur * availH) / gfR.height);
      } else {
        /* 容器可用宽 = game_area 内容宽 − 16px 余量；基准宽用整个银框窗
           （gwrap，含竖排计数列——zoom 挂 gwrap 后计数列随盘同缩，一起封顶）。
           offsetWidth 不含 zoom（实测），与 zoomCur 是否同步无关 */
        const gaW = gaR.width / pageZoom() - 16;
        cap = gaW / gwrap.offsetWidth;
      }
      return Math.max(zMin, Math.min(2.5, cap));
    }
    /* 首次进入（localStorage 无记忆）的默认比例（2026-10-14 张老师二定：固定 1.71）：
       此前按「高级盘刚好填满版块」动态计算，宽视口下会算到 2.1x+，观感偏大。
       现固定 1.71；窄屏放不下时由 applyZoom→normalMaxZoom 按容器宽自动封顶
       （≥0.5），手动调整仍写 localStorage 记忆（默认值 persist=false 不写盘） */
    function defaultZoom() {
      return 1.71;
    }
    /* 只改渲染与两处滑杆的显示，不封顶、不写盘——供「比例滑杆拖动中」使用：
       拖动中若走 applyZoom 的封顶，页宽与倍数互相压制会把盘面卡在容器宽
       （用户感觉比例调不大）；松手（pointerup/change）再由 applyZoom 正式定值。
       zoom 挂 .gwrap（2026-10-14 张老师定：计数条/笑脸/棋盘/状态栏同比例缩放，
       原先只缩 gframe 会导致 LED 与棋盘比例脱节）；greport/gresult 已挪出 gwrap
       不受连带，由 syncReportZoom 独立缩放 */
    function setZoomVisual(v: number) {
      gwrap.style.zoom = String(v);
      zoomCur = v;
      zoomRange.value = String(v);
      paintRangeFill(zoomRange);
      zoomVal.textContent = v.toFixed(2) + "x";
      /* 自定义弹窗内的比例滑杆同步（v7 张老师 19:07：比例并入自定义弹窗，
         免得两个浮窗来回切）——与设置浮窗那张是同一份状态的两个视图 */
      cusZoom.value = String(v);
      paintRangeFill(cusZoom);
      cusZoomVal.textContent = v.toFixed(2) + "x";
      syncReportZoom(); // 结算面板同步缩放（显示中才生效）
    }
    function applyZoom(v: number, persist = true, max?: number) {
      zoomWant = v; // 玩家期望倍率（clamp 前）：syncPageFit 按它算页宽
      const cap = max ?? normalMaxZoom();
      /* 大盘自动缩可低于滑杆 min（0.5）：cus 盘封顶 <0.5 时直接用封顶值
         （滑杆拖不到但自动适配到位——99 宽盘在扩展版式下仍可能需 <0.9x） */
      const floor = lv === "cus" ? Math.min(0.5, cap) : 0.5;
      v = Math.max(floor, Math.min(cap, v));
      zoomRange.max = String(cap); // 滑杆行程同步封顶，拖杆手感与实际一致
      cusZoom.max = String(cap);
      setZoomVisual(v);
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
       五期三改：zoom 移到 .gwrap 后，面板挂在 #game_area（gwrap 外）不吃游戏倍率，
       自身 zoom 显式同步；left/top 按 gwrap 渲染矩形直译（页面坐标 → game_area
       局部坐标），顶端与 gwrap 银框顶缘对齐、左/右各留 14px 间隙。
       上限：面板放大后不得越出视口——rect 实测反算基准宽/高（rect =
       基准尺寸 × 面板 zoom × 页级 zoom，当前 style.zoom 已知，一次除法解出）。
       低倍率下不放大过游戏倍率本身（跟手感），高倍率下按空间封顶防裁切 */
    function syncReportZoom() {
      if (!greport.classList.contains("show")) return;
      const rect = greport.getBoundingClientRect();
      const pz = pageZoom();
      const curZ = parseFloat(greport.style.zoom || "1") || 1;
      const rawW = rect.width / (curZ * pz); // 面板基准尺寸（未缩放布局尺寸）
      const rawH = rect.height / (curZ * pz);
      if (!rawW || rawW < 1 || !rawH || rawH < 1) return;
      const gwR = gwrap.getBoundingClientRect();
      const availW = gwR.left - 12 - 14; // 视口左缘 12px + 贴边间隙 14px
      const availH = window.innerHeight - gwR.top - 12;
      const cap = Math.max(0.5, Math.min(2.5,
        Math.min(availW / (rawW * pz), availH / (rawH * pz))));
      const z = Math.max(0.5, Math.min(zoomCur, cap));
      greport.style.zoom = String(z);
      gresult.style.zoom = String(z);
      /* 定位：面板 zoom 会缩放 left/top 偏移 → 先除回；game_area 局部坐标 =
       (gwrap 渲染坐标 − game_area 渲染坐标) ÷ 页级 zoom（game_area 无 zoom） */
      const gaR = gameAreaEl.getBoundingClientRect();
      const toLocal = (v: number) => v / pz / z;
      greport.style.top = toLocal(gwR.top - gaR.top) + "px";
      greport.style.left = toLocal(gwR.left - gaR.left - 14) - rawW + "px";
      gresult.style.top = toLocal(gwR.top - gaR.top) + "px";
      gresult.style.left = toLocal(gwR.right - gaR.left + 14) + "px";
    }
    /* 全屏自动拉满（2026-10-14 张老师定，主要面向手机）：取宽/高两个方向较小的倍率。
       量纲事实（Chrome 实测）：offsetWidth/Height 不含 zoom（含自身 zoom 也不含），
       即基准尺寸；getBoundingClientRect 是渲染尺寸（含 zoom 与页级 zoom）。
       zoom 挂 .gwrap 后基准取整个银框窗（计数条/棋盘/状态栏同比例缩放）。
       绝对式：倍率 = 目标渲染尺寸 ÷ 基准尺寸 ÷ 页级 zoom，与 zoomCur 无关。
       max 放到 5：手机上页级 0.65 会把游戏倍率缩回去，拉满常需 3+（不进 localStorage） */
    function fitZoomForFullscreen() {
      gwrap.style.minHeight = ""; // 撤掉横屏的银框兜底拉伸（横屏中进全屏时残留会撑歪）
      const baseW = gwrap.offsetWidth, baseH = gwrap.offsetHeight;
      if (baseW < 8 || baseH < 8) return;
      const pz = pageZoom();
      const gaR = gameAreaEl.getBoundingClientRect();
      const gwR = gwrap.getBoundingClientRect();
      /* 银框之外占掉的高度（game_area 内的其他流内内容）用 rect 差值量；
         不能用 root.scrollHeight——全屏时它会被视口高度撑大 */
      const othersH = Math.max(0, (gwR.top - gaR.top) + (gaR.bottom - gwR.bottom));
      const targetW = window.innerWidth - 24;             // :fullscreen 左右 padding 12px
      const targetH = window.innerHeight - 48 - othersH;  // :fullscreen 上下 padding 24px
      applyZoom(Math.min(targetW / baseW, targetH / baseH) / pz, false, 5);
    }
    /* 设置浮窗这张比例滑杆与自定义弹窗那张同源（v7）：共用 zoomDragInput/zoomDragEnd，
       拖动中不重算页宽、松手后一次到位（理由见 zoomDragInput 注释） */
    on(zoomRange, "input", () => zoomDragInput(parseFloat(zoomRange.value)));
    on(zoomRange, "pointerup", zoomDragEnd);
    on(zoomRange, "change", zoomDragEnd);

    /* ---- 3BV 范围双端点滑杆（2026-10-14 二期）----
       两条原生 range 叠放：轨道/填充条只负责视觉（CSS 变量 --lo/--hi 定位），
       thumb 透明轨道 pointer-events:none + thumb 自身 auto——两条滑杆互不挡命中。
       交互约束：上/下界最小差 10（拖过头自动钳回）；范围外拖不动。
       当前级别范围存 bvSel[lv]，改完立即写 localStorage；
       只影响之后生成的盘（进行中对局不重开——重开按钮/切级别才用新范围）。 */
    const bvLo = $("bv_lo") as HTMLInputElement;
    const bvHi = $("bv_hi") as HTMLInputElement;
    const bvDual = $("bv_dual") as HTMLElement;
    const bvRow = bvDual.parentElement as HTMLElement; // .gs_bv 整行：title 承载级别统计区间提示
    const bvCur = $("bv_cur");
    const LV_NAMES: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
    function syncBvSlider() {
      /* 自定义盘无统计区间：整个 3BV 区禁用（半透明 + 滑杆不可拖 + title 说明） */
      const cus = lv === "cus";
      bvRow.classList.toggle("cus", cus);
      [bvLo, bvHi].forEach((el) => {
        el.disabled = cus;
      });
      if (cus) {
        bvRow.title = "自定义盘面不支持 3BV 筛选";
        bvCur.textContent = "—";
        return;
      }
      const r = bvRanges[lv as keyof BvRanges], s = bvSel[lv];
      bvLo.min = bvHi.min = String(r.min);
      bvLo.max = bvHi.max = String(r.max);
      bvLo.value = String(s.lo); bvHi.value = String(s.hi);
      bvDual.style.setProperty("--lo", ((s.lo - r.min) / (r.max - r.min)) * 100 + "%");
      bvDual.style.setProperty("--hi", ((s.hi - r.min) / (r.max - r.min)) * 100 + "%");
      bvRow.title = LV_NAMES[lv] + "统计区间 " + r.min + "–" + r.max;
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
       CSS 已把标题/筛选器移到侧面竖排，这里把游戏按视口高度拉满（页面无需滚动）。
       绝对式量纲（与 fitZoomForFullscreen 同源）：目标渲染尺寸 ÷ 基准尺寸，
       与当前 zoomCur 无关（此前乘法式在 zoomCur 与实际渲染脱钩——StrictMode
       双挂载 / applyModeZoom 覆写时——会把倍率算飞，高级盘横屏拉满失效的根因）。
       目标一律取 visualViewport（真实屏宽高）：超宽盘曾把布局视口撑爆，
       innerWidth/innerHeight 被浏览器放大后 rect 全失真，visualViewport 不受影响。
       手动拖滑杆后以手动为准，退出横屏恢复进前倍率 */
    /* 游戏区容器（面板锚 & 横屏测量共用；声明提前避免 syncReportZoom 的暂时性死区） */
    const gameAreaEl = $("game_area") as HTMLElement;
    let zoomBeforeLs: number | null = null; // 进横屏前的倍率；横屏中手动调过则置 null 不再恢复
    function fitZoomForLandscape() {
      if (document.fullscreenElement === root) return; // 全屏拉满优先
      /* 基准量测前先撤掉上一次的「银框兜底拉伸」（见本函数末尾）——否则拉伸会被
         当成自然基准、越拉越高（每次 fit 都是一次干净重算） */
      gwrap.style.minHeight = "";
      /* zoom 挂 .gwrap：基准取整个银框窗（竖排计数列随盘同缩），offsetWidth/Height
         实测不含 zoom（Chrome，含自身 zoom 也不含） */
      const baseW = gwrap.offsetWidth, baseH = gwrap.offsetHeight;
      if (baseW < 8 || baseH < 8) return;
      const pz = pageZoom();
      const vv = window.visualViewport;
      const vw = (vv ? vv.width : window.innerWidth) / pz;
      const vh = (vv ? vv.height : window.innerHeight) / pz;
      const gaR = gameAreaEl.getBoundingClientRect();
      const gwR = gwrap.getBoundingClientRect();
      /* 高度目标 = 屏高 − game_area 顶 − 底部余量 − 银框之外占高（rect 差值法）；
         宽度目标 = 屏宽 − 固定横向开销（只剩 box 左右边框，LS_RESERVE_W）。
         vw/vh 已除 pz 归一成布局 px，rect 量出的部分同样除 pz，倍率不再另除。
         底部余量 8 → 1（2026-10-15 二定「严格占满 100% 高度」）：页级 margin/padding
         与 .box 的 margin/padding 已在 CSS 横屏块清零，视口底只剩 box 那 1px 边框，
         再留 8px 会在棋盘下方露出一条板块背景色 */
      const othersH = Math.max(0, (gaR.height - gwR.height) / pz);
      const targetH = vh - gaR.top / pz - 1 - othersH;
      const targetW = vw - LS_RESERVE_W;
      applyZoom(Math.min(targetW / baseW, targetH / baseH), false, 5);
      /* 试探性补差（2026-10-15 二定「严格占满 100%」）：首算用的是 offset* 基准
         （取整值，实测 155 vs 真值 154.79）且首帧布局未落位，常低 2-3px。
         补差用**棋盘窗自身实测 rect** 反算（rect 与 zoom 同步缩放，比值自洽，
         不依赖 zoomCur 与渲染是否同步，也不必管 flex-start 下 game_area 与盘面的
         高度差）。⚠️ 只试一次且**过则回退**：棋盘窗高度是离散的（整格 × zoom，
         实测 zoom 2.4995→2.5 之间高度从 386.8 跳到 389），补差可能一脚跳过头，
         宁可小 2px 也不能让棋盘下缘被视口裁掉 */
      const z0 = zoomCur;
      const gw1 = gwrap.getBoundingClientRect();
      if (gw1.height > 8 && gw1.width > 8) {
        const grow = Math.min(
          (vh - gw1.top / pz - 1) / (gw1.height / pz),
          (vw - gw1.left / pz - 1) / (gw1.width / pz),
        );
        if (grow > 1.002) {
          applyZoom(z0 * grow, false, 5);
          const gw2 = gwrap.getBoundingClientRect();
          if (gw2.bottom / pz > vh - 1 || gw2.right / pz > vw - 1) applyZoom(z0, false, 5); // 跳过头 → 回退
        }
      }
      /* 银框窗兜底拉满：棋盘高度离散化后总差几 px 踩不到视口底，落在窗外就是张老师
         看到的「底部露板块背景色」。这里不追棋盘，改把**窗**（gwrap，银底 + 凸起边框）
         用 min-height 补到视口底——补出的空间落在银框内部（银底/棋格内衬），肉眼不可见，
         棋盘尺寸与手感分毫不动。
         量纲：窗显示高 = 布局高 × zoom（zoom 挂 gwrap 自身），故 min-height 按
         「当前布局高 + 缺口 ÷ zoom」递增；两轮实测逼近（Chrome 的 zoom 取整会让
         显示高与布局高×zoom 差 ~1px，一次算不准）。每次 fit 开头先撤旧值，
         免得下一次把上次的拉伸计入基准 */
      for (let i = 0; i < 2; i++) {
        const r = gwrap.getBoundingClientRect();
        const deficit = vh - 1 - r.bottom / pz; // 距视口底还差多少（显示 px，扣 box 1px 边框）
        if (deficit <= 0.5) break;
        const cur = parseFloat(gwrap.style.minHeight) || 0;
        gwrap.style.minHeight = Math.ceil(Math.max(cur, baseH) + deficit / zoomCur) + "px";
      }
    }
    function syncLandscape() {
      if (lsQuery.matches) {
        if (zoomBeforeLs === null) zoomBeforeLs = zoomCur;
        window.scrollTo(0, 0); // 顶满高度以页面顶为基准，先回顶再量
        window.setTimeout(fitZoomForLandscape, 60); // 等媒体查询布局生效后测量
      } else if (zoomBeforeLs !== null) {
        gwrap.style.minHeight = ""; // 退出横屏撤掉银框兜底拉伸（竖屏窗口不该被撑高）
        applyZoom(zoomBeforeLs, false);
        zoomBeforeLs = null;
      }
    }
    lsQuery.addEventListener("change", syncLandscape, { signal });

    on(document, "keydown", (e: KeyboardEvent) => {
      /* F2 ≡ 点笑脸重开（2026-10-14 张老师定）：必须与鼠标点笑脸完全同路——
         回放中、自定义弹窗开着、焦点在控件上，都一律重开，不做任何拦截。
         （reset 内部已自带 forceExitReplay，回放中重开是安全的；此前 replaying
         早退让 F2 在回放中哑火，与点笑脸行为不一致，张老师报过） */
      if (e.key === "F2") {
        e.preventDefault();
        reset();
        return;
      }
      /* r/R 仍守旧规矩：弹窗开着（输入框里打字）/ 回放中不响应，避免误触清盘 */
      if (cusDlg.classList.contains("open")) return;
      if (replaying) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "r" || e.key === "R") reset();
    });

    /* ---- 重玩本局（五期）：replayBoardLocked=true 时，下一局的雷区完全复刻 pendingBoard，
       不做 3BV 筛选、不做无猜重排准备（无猜在重玩局强制关闭）；首击仍走 openCell 的
       started 分支，但 placeMines 检测到锁定盘直接注入、跳过所有随机生成 ---- */
    let replayBoardLocked = false;
    let pendingBoard: Uint8Array | null = null;
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
        ngRedeals: () => ngRedeals,
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
    swStats.checked = showStats;
    syncBvSlider();

    /* 开局恢复上次级别（四期张老师报：刷新/热更后回初级，3BV 范围浮窗也跟着变初级
       区间与玩家脱节）——无记忆/脏数据回落 beg；级别入 localStorage（saveSettings） */
    reset(savedLv || "beg");
    /* 比例：统一走 applyModeZoom（标准级别读 online_play_zoom、cus 读 online_play_zoom_cus，
       与切级别路径同一套记忆逻辑）。默认值不写盘——只有玩家手动拖滑杆/重置才记忆；
       全屏与横屏的自动拉满同样不入记忆（三期 v3 张老师定） */
    applyModeZoom();
    if (lsQuery.matches) syncLandscape(); // 初始即横屏：记住倍率并拉满

    return () => {
      ac.abort(); // 摘除全部事件监听
      fsTip.remove(); // iOS 引导浮层挂在 body 上，随组件卸载一起收走
      /* 移动端结算浮层（七期）同样挂在 body 上：卸载时先卸雷达 React root 再摘元素 */
      radarRootRef.current?.unmount();
      radarRootRef.current = null;
      grModal.remove();
      document.documentElement.classList.remove("op-fakefs"); // 伪全屏态不跨页残留
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
        <h1>练习</h1>
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

        {/* 设置浮窗：齿轮点开（无头部栏/关闭按钮——外点、Esc、再点齿轮均可关）；
            含 NF/无猜/问号/显示统计 开关、显示比例滑杆、3BV 范围双端点滑杆。
            （「显示3BV」开关已随状态栏一并取消，八期。）
            全部状态入 localStorage（online_play_settings），比例仍走原 online_play_zoom 键 */}
        <div className="gsettings" id="gsettings">
          {/* 开关名 ≤4 字（2026-10-14 张老师定），完整解释放 hover 气泡（.tip） */}
          <div className="gs_row">
            <span className="gs_name">NF模式</span>
            <label className="gsw"><input type="checkbox" id="sw_nf" /><span className="track" /></label>
            <span className="tip">禁旗模式：不能插旗，全程只靠开格决胜</span>
          </div>
          <div className="gs_row">
            <span className="gs_name">无猜模式</span>
            <label className="gsw"><input type="checkbox" id="sw_ng" /><span className="track" /></label>
            <span className="tip">踩雷自动重排本局，盲点必开出空域，永远不用猜</span>
          </div>
          <div className="gs_row">
            <span className="gs_name">问号标记</span>
            <label className="gsw"><input type="checkbox" id="sw_qm" /><span className="track" /></label>
            <span className="tip">右键按 标雷 → 问号 → 取消 三态循环</span>
          </div>
          {/* 「显示统计」（2026-10-15 六期张老师定，默认关）：左侧数据统计面板的唯一入口。
              八期改口径：只在游戏结束时出现（对局中不再常驻实时刷新） */}
          <div className="gs_row">
            <span className="gs_name">显示统计</span>
            <label className="gsw"><input type="checkbox" id="sw_stats" /><span className="track" /></label>
            <span className="tip">游戏结束后在游戏界面左侧弹出数据统计面板</span>
          </div>
          <div className="gs_divider" />
          <div className="gs_zoom">
            <span className="zlabel">显示比例</span>
            <input type="range" id="zoom_range" min="0.5" max="2.5" step="0.05" defaultValue="1" />
            <span className="zval" id="zoom_val">1.00x</span>
          </div>
          <div className="gs_divider" />
          {/* 3BV 范围：单行——标签 + 双端点滑杆 + 当前选中区间数字（2026-10-14 张老师定）。
              级别统计区间提示收进整行 hover title（自定义盘时是"不支持筛选"说明） */}
          <div className="gs_bv">
            <span className="bname">3BV 范围</span>
            <div className="dual" id="bv_dual">
              <div className="rail" /><div className="fill" />
              <input type="range" id="bv_lo" min="2" max="51" step="1" defaultValue="2" />
              <input type="range" id="bv_hi" min="2" max="51" step="1" defaultValue="51" />
            </div>
            <span className="bcur" id="bv_cur">2 – 51</span>
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
          {/* 显示比例（v7 张老师 19:07）：与设置浮窗的 #zoom_range 是同一状态的
              两个视图（applyZoom 内统一同步），自定义盘原地调大小不用另开浮窗 */}
          <div className="cus_row cus_row_zoom">
            <span className="cname">比例</span>
            <input type="range" id="cus_zoom" min="0.5" max="2.5" step="0.05" defaultValue="1" />
            <span className="cval" id="cus_zoom_val">1.00x</span>
          </div>
        </div>
      </div>

      <div id="game_area">
        <div className="gwrap">
          {/* 计数条（雷数/笑脸/计时）与状态栏在 .gwrap 内、gframe 外：
              桌面端银灰外框在 .gwrap 上、视觉与旧结构完全一致；
              zoom 挂 .gwrap——整窗（计数条+棋盘+状态栏）同比例缩放（2026-10-14 张老师定） */}
          <div className="gbar">
            <svg className="ledc" id="led_mines" viewBox="0 0 410 250" role="img" aria-label="剩余雷数">
              <use href="#top-counters" />
              <use className="d" href="#count-0" x="20" y="20" />
              <use className="d" href="#count-1" x="150" y="20" />
              <use className="d" href="#count-0" x="280" y="20" />
            </svg>
            <button className="face" id="face_btn" title="重新开始 (F2)" type="button">
              <svg viewBox="0 0 260 260" width="26" height="26"><use id="face_use" href="#face-normal" /></svg>
            </button>
            <svg className="ledc" id="led_time" viewBox="0 0 410 250" role="img" aria-label="计时">
              <use href="#top-counters" />
              <use className="d" href="#count-0" x="20" y="20" />
              <use className="d" href="#count-0" x="150" y="20" />
              <use className="d" href="#count-0" x="280" y="20" />
            </svg>
          </div>
          <div className="gframe" id="gframe">
            <div className="gboard_wrap">
              <div className="board size16 game" id="gboard">
                <table cellPadding="0" cellSpacing="0"><tbody id="gtbody" /></table>
                {/* 矢量管线整盘渲染面（≥1.5x 才显示）：table 管布局与命中，视觉由这张 SVG 画 */}
                <svg className="vecboard" id="vec_board" aria-hidden="true" />
              </div>
            </div>
          </div>
          {/* 状态栏已取消（八期张老师定「没有意义」）：级别名与筛选 tabs 重复，
              3BV 归数据统计面板、NF/无猜是玩家自己开的开关——整条银条删除 */}
        </div>
        {/* 结算报告浮窗 / 右侧结算面板：挂在 #game_area（gwrap 之外）——
            zoom 移到 gwrap 后，面板不再被游戏倍率连带（自身 zoom 由 syncReportZoom
            独立设置），定位改为跟随 gwrap 渲染矩形（JS syncReportZoom 内换算） */}
        <div className="greport" id="greport" />
        <div className="gresult" id="gresult" />

        {/* 比例控制条已移入设置浮窗（2026-10-14 二期张老师定：页面只留游戏本体）；
            触屏「插旗模式」按钮已废（同日张老师定）——移动端插旗一律长按 ≥150ms */}
      </div>
    </div>
  );
}
