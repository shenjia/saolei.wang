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
//   ① 左侧「数据统计」面板默认不显示（2026-10-16 张老师定改默认开，见 showStats 注释）——
//      新增设置开关「显示统计」，开启后只在游戏结束时弹出（对局中不刷新，八期口径），
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
import { replayCounts, MOUSE_CODE_TO_EV, type ReplayCounts } from "@/lib/replay-core";
import { LEVEL_NAMES } from "@/lib/config";
import { paintRangeFill } from "@/lib/paintRange";
import type { VideoAnalysisPoint } from "@/lib/videoscore";
import {
  DIST_BUCKET_ALL,
  gradeColor,
  radarOverall,
  radarPointsFrom,
} from "@/lib/videoscore";

/* 各级别 3BV 统计区间（服务端 /online page 从 level_3bv_range 表读取注入） */
export type BvRanges = Record<"beg" | "int" | "exp", { min: number; max: number }>;

/* localStorage 设置键（2026-10-14 二期：全部设置入 localStorage 记住） */
const LS_KEY = "online_play_settings";
/* 移动端连击模式自动开启的一次性标记（2026-10-19）：存在＝已初始化过，不再自动开 */
const COMBO_AUTO_KEY = "online_play_combo_auto";
/* 开局 tips 的已显记录键（2026-10-19）：{ d: 当天日期串, n: 今天已显示过的 TIPS 索引 }
   ——日期变了整组作废（次日重新轮起），当天不重复、全部出现过后不再提示 */
const TIP_STATE_KEY = "online_play_tips";

/* 自定义规格范围（三期，2026-10-14 18:2x 张老师定）：
   下限 8——8×8 以下盘面撑不住 #page 版式（格子太少时 gframe 过窄、页脚版块会被挤变形）；
   上限 99。
   ⚠️ 必须放模块顶层——JSX 渲染作用域够不着 useEffect 闭包内的常量
   （2026-10-14 别线会话曾放闭包内导致 CUS_MIN is not defined 整页崩溃） */
const CUS_MIN = 8, CUS_MAX = 99;

/* 自定义滑杆拖动时盘面重建的节流间隔（ms）。99×99 全量重建 + 重绘每帧都做会卡手，
   张老师 2026-10-14 18:19 定：拖动时盘面变化允许 250ms 一次（leading 立即 + trailing 终值） */
const CUS_APPLY_MS = 250;

/* ---- 自定义盘版式（v8，2026-10-16 张老师定）----
   v7 曾让 #page 宽度跟随盘面精算（小盘收窄、大盘扩宽），实践下来切入自定义
   主版块会突然变小、与页头宽度脱节。张老师定：**版块宽度始终与 header 一致**——
   #page 恒走常规 62%/min620/max960 版式，不再按盘面改写页宽；
   大自定义盘超宽时由 normalMaxZoom 按容器自动缩（下限放宽到 0.3）保证完整可见 */
/* 手机横屏固定横向开销（布局 px）→ fitZoom* 与 normalMaxZoom 共用。用固定值而非
   rect 实测：超宽盘会把布局视口撑爆、rect 全失真。zoom 挂 .gwrap 后银框（含竖排
   计数列）整体随盘缩放，拉满基准即整个银框窗，预留不再含框/计数列。
   ⚠️ 2026-10-15 演进：沉浸模式砍掉左栏 240→40；二定「严格占满」清掉 #page/.box
   的 margin/padding → 40→2；三定「去外框」连 .box 的 1px 镶边也去（CSS 横屏块
   border:none）→ 现在是纯亚像素防溢出余量（zoom 渲染取整有 ±0.3px 抖动） */
const LS_RESERVE_W = 2;
/* 移动端全屏拉满的亚像素余量（布局 px）：Chrome 的 zoom 渲染取整会让「渲染高」与
   「布局高 × zoom」差 ~1px（实测同一窗在 1.71x 反算 207.61、3.82x 反算 207.86），
   卡到 0 余量时宿主 scrollHeight 会多出 1px → 平白冒出一条竖滚动条。
   两个方向各留 2px（同横屏 LS_RESERVE_W 的取舍：宁小 2px，不裁内容/不出滚动条） */
const FS_RESERVE = 2;
/* 滚轮调显示比例（2026-10-15 张老师定「练习页禁滚动，滑动鼠标滚轮可调整显示比例」）：
   累计滚动量（归一化到像素）每满 WHEEL_STEP_PX 迈一格 WHEEL_STEP_Z。
   按**累计**而非「每个 wheel 事件迈一格」——触控板惯性连滚一次能出十几个事件，
   逐个迈格会瞬间飞到上限；鼠标滚轮一格在 Chrome 恰好报 100px，正好一格。
   步进 0.1x（滑杆 step 0.05 的两档）：0.5→5 全程约 45 格滚动，既不粘滞也不失手。
   ⚠️ 方向约定：deltaY<0（上滑/远离自己）＝放大，同浏览器 Ctrl+滚轮与地图类应用 */
const WHEEL_STEP_PX = 100;
const WHEEL_STEP_Z = 0.1;
/* 单个 wheel 事件最多迈几格：有些鼠标/驱动一格就报 deltaY 300~500（Windows 的
   120 或系统「一次滚多行」设置），不封顶会一次跳 0.5x 以上、手感失控。
   封顶时把累计清零（而不是继续留余量），免得下一格又跳一次 */
const WHEEL_MAX_STEPS = 5;

/* ---- 开局 tips（2026-10-15 张老师定「进页一条」，2026-10-19 改口径为「每局一条」）----
   每次开局（reset）从池里取一条**当天还没出现过**的，在主板块底部以气泡浮现
   （正文前一枚金色灯泡），3 秒后渐隐；已显记录存 localStorage（TIP_STATE_KEY，
   按天记录）——当天不重复，全部出现过后当天不再提示（次日重新轮起）。
   设置浮窗「开局提示」开关（默认开）可整体关闭，关闭后任何提示都不出。
   ⚠️ 文案一律只写**已上线**的既有行为（口径与设置浮窗 .tip / 各按钮 title 一致），
      别把计划中或已废弃的功能（如「显示3BV」「极简模式」）写进来 */
const TIPS: string[] = [
  "手机上把屏幕横过来，棋盘会自动拉满整屏，视野更开阔。",
  "点右上角全屏按钮进入沉浸模式，页面其他内容全部让位。",
  "无猜模式下需要靠猜的局面会自动重排，全程都能靠推理解决。",
  "鼠标滚轮可直接调显示比例：上滑放大，下滑缩小。",
  "设置里能限定 3BV 范围，只练你想要的开局难度。",
  "练习局的录像只能自己回看，不能上传参与排行。",
  "在线练习录像不能参与排行，下载后仅供自己回看。",
  "手机上长按格子可以标雷，标完会自动展开周围已满足的数字格。",
  "按 F2（或点笑脸）随时重开一局，不必等这局走完。",
  "禁旗模式（NF）下不能插旗，按下即开，滑动可以开多格。",
  "连击模式下按下鼠标即触发，按住左/右键滑动可连续点击滑过的格子（一格一次）。",
  "左右键同按（或单击已满足的数字格）可一次展开一圈，比逐格点快。",
  "自定义盘可以自由设定宽、高、雷数（8 – 99），想练什么规格都行。",
  "每局结束会给出 STNB 与五维雷达评级，口径与录像详情页一致。",
];
/* tips 生命周期（ms）：fade-in 由挂载后下一帧加 .show 触发；
   TIP_HOLD_MS 后撤 .show 走 transition 渐隐，TIP_FADE_MS 后整块卸载。
   「3 秒后渐隐」＝ 从浮现到开始消失共 3 秒，渐隐本身 0.7s 不占额度 */
const TIP_HOLD_MS = 3000;
const TIP_FADE_MS = 700;

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
    /* 练习页禁滚动（2026-10-15 张老师定）：整页锁死滚动，滚轮改由 onWheelZoom
       调整显示比例（见文末）。类挂在 <html> 上、随组件挂载/卸载增删，不污染站内
       其他页面（同 op-fakefs 的做法）。⚠️ 必须在任何 fit 之前加：页面滚动条消失
       会让视口宽 +15px，后面的 normalMaxZoom 按新宽度算才准；
       副作用是内容超一屏时页面下方（页脚）不再可滚达——本页即一屏棋盘，可接受 */
    document.documentElement.classList.add("op-noscroll");
    const ac = new AbortController();
    const signal = ac.signal;
    const on = <E extends Event>(
      el: HTMLElement | Document | Window,
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

    /* ---- 开局气泡 tips + 局中通知气泡（2026-10-19 张老师定）----
       tips：每次开局（reset 末尾调 showTip）显示一条**当天未出现过**的（TIPS 池，
       已显记录入 localStorage 按天存），全部出现过后当天不再提示；
       设置浮窗「开局提示」开关关闭则任何提示都不出。
       toast：绿色通知气泡（如下载成功），用时动态创建、渐隐后自摘。
       走**命令式 DOM**而不是 React state：
       ① 文案选择只能客户端做——渲染期做会撞 react-hooks/purity，且 SSR 与客户端
          两条结果不同即 hydration mismatch（故 JSX 里 .txt 恒为空，文字在这里填）；
       ② 主 useEffect 本就是本组件的「外部系统同步区」，
          react-hooks/set-state-in-effect 规则禁止在 effect 体里同步 setState。
       ⚠️ 元素脱流绝对定位（CSS 里写死），出现/消失都不改版面高度——
          页面锁滚 + 棋盘按视口 fit，任何高度变化都会让 fit 基准偏移、棋盘跳动。
       #op_tips 元素常驻不摘（切 display 由 .show 控制）：每局都要复用它，
       反复摘挂既浪费也让「重复挂载撞 id」的旧顾虑回来 */
    const tipsEl = root.querySelector<HTMLElement>("#op_tips")!;
    /* 上一条 tips 的渐隐定时（快速连开新局时重置，避免上一条的定时把新气泡提前掐灭） */
    let tipFadeTimer: number | null = null;
    function showTip() {
      if (!tipsOn) return;
      let idx = -1;
      try {
        const today = new Date().toDateString();
        const st = JSON.parse(localStorage.getItem(TIP_STATE_KEY) || "null") as
          { d?: string; n?: number[] } | null;
        const shown = st && st.d === today && Array.isArray(st.n) ? st.n : [];
        /* 当天没出过的才有资格；全出过 → 本局不提示 */
        const unseen: number[] = [];
        for (let i = 0; i < TIPS.length; i++) if (!shown.includes(i)) unseen.push(i);
        if (!unseen.length) return;
        idx = unseen[Math.floor(Math.random() * unseen.length)];
        shown.push(idx);
        localStorage.setItem(TIP_STATE_KEY, JSON.stringify({ d: today, n: shown }));
      } catch { /* 隐私模式：退化为纯随机、不记录（下次可能重复，可接受） */
        idx = Math.floor(Math.random() * TIPS.length);
      }
      tipsEl.querySelector(".txt")!.textContent = TIPS[idx];
      if (tipFadeTimer !== null) clearTimeout(tipFadeTimer);
      /* 下一帧再挂 .show：确保从 opacity:0 初始态起步，同帧加类会被合并、
         transition 不触发（气泡就「闪」一下没了） */
      requestAnimationFrame(() => tipsEl.classList.add("show"));
      tipFadeTimer = window.setTimeout(() => tipsEl.classList.remove("show"), TIP_HOLD_MS);
    }
    /* 局中绿色通知气泡（下载成功等）：复用 .optips 形态叠 .optoast 绿色变体，
       动态创建、show 即现、TIP_HOLD 后渐隐、渐隐完自摘（与 tips 不同不用常驻） */
    function showToast(msg: string) {
      const t = document.createElement("div");
      t.className = "optips optoast show";
      t.setAttribute("role", "status");
      t.textContent = msg;
      container.appendChild(t);
      window.setTimeout(() => t.classList.remove("show"), TIP_HOLD_MS);
      window.setTimeout(() => t.remove(), TIP_HOLD_MS + TIP_FADE_MS);
    }

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
    /* 无猜为独立开关；全屏开关只控制显示、不影响对局；
       问号开关（默认关）只影响右键循环是否经过问号态，切换不重开。
       无猜默认开（2026-10-15 张老师定）；localStorage 存过偏好的浏览器仍按存值恢复。
       二期起这些开关收进设置浮窗，初始值从 localStorage 恢复。
       「显示3BV」开关已废（2026-10-15 八期张老师定：状态栏整个取消，见 gname 注释） */
    /* NF 模式（2026-10-19 张老师定：恢复保留，语义收窄）——**仅仅限制不能右键**：
       右键按下只抖 NF 钮反馈、不录任何事件（对局里零右键点击），左键行为与常规完全
       一致；不再携带旧版的「按下即开/滑动连开」（那部分已独立成连击模式）。
       与速旗互斥（继续沿用 2026-10-16 口径）：打开其一自动关闭另一者，NF 切换重开。
       激活显色＝默认黄（.gicon.active 站内黄，2026-10-19 二次定）。 */
    let nf = false;
    let ng = true, qmark = false;
    /* 「连击模式」（2026-10-19 张老师定，默认关，入口＝原 NF 快捷钮位）：
       NF 模式退役换防——「按下即开＋滑动连开」交互保留并扩展到右键：
       ① 左键按下即触发——未开格直接开（录完整 lc+lr 对）、已开数字直接双击（sc+lr）；
       ② 右键按下即触发——未开格直接插旗（录完整 rc+rr 对）；
       ③ 按住任一键滑动＝对滑过的格子连续点击，一格限一次（state 守卫天然保证：
          开过/旗过 state 变更即不会二次触发）；松开不补录事件（配对在触发时已闭合）。
       与速旗模式**不再互斥**（可叠加）。移动端（pointer:coarse）首次进入自动开启。
       localStorage 键 combo */
    let combo = false;
    /* 「速旗模式」（2026-10-16 张老师定，默认关，快捷钮小旗）：
       ① 标旗（右键/长按插上旗）后自动对周围已开数字格做 chord——预检「旗数满足且有
       未开非旗邻格」才执行并录 mr 事件（计一次 Double）；开不出格的空 chord 不执行
       也不计数；② 左右键点已开数字都视为双击——左键本就全局生效（见 mouseup
       「单击已开数字格＝双击」分支），速旗新增的是右键点已开数字也 chord（录 mr，
       不录 rc：引擎里 rc 落在已开格会挂起 rv、随后的 rr 计一次 wasted 右键，口径就歪了；
       mr 引擎无条件计 Double，与左键单击数字同口径）。
       localStorage 键沿用旧「自动双击」开关的 autoChord（平滑迁移） */
    let autoChord = false;
    /* 「显示统计」开关（2026-10-15 六期张老师定；2026-10-16 张老师定默认开）：左侧「数据统计」
       面板的**唯一**显示开关。八期改口径：开＝也只在**游戏结束**时随结算弹出（对局中不再
       常驻实时刷新——张老师定「只有游戏结束才出现数据面板」）；关＝任何时刻都不显示。
       再开局撤下。localStorage 存过偏好的浏览器仍按存值恢复。 */
    let showStats = true;
    /* 「开局提示」开关（2026-10-19 张老师定，默认开）：每次开局显示一条技巧气泡
       （showTip，见上方 tips 块）——当天不重复、全部出现后不再提示；
       关闭后任何开局提示都不出（下载成功等局中通知气泡不受它管） */
    let tipsOn = true;
    /* 局末定格的统计面板 HTML（2026-10-15 十期张老师定）：report 时无论开关与否都存
       一份——局后补开「显示统计」时直接复用，不再重算（胜利自动补旗/败局揭雷之后
       重算会把 Flags 等口径算歪），保证与当时应弹出的面板逐字一致。
       仅 over（局末定格状态）时消费，reset 开新局后 over=false 自然失效 */
    let lastReportHtml: string | null = null;
    /* 无猜重排生效次数（踩一次雷/一个盲点算一次，内部重试不算）。
       状态栏取消后无 UI 消费，仅保留给 dev 测试钩子（__op.ngRedeals）验证重排逻辑 */
    let ngRedeals = 0;
    /* 触雷被重排救回的次数（不计安全盲点换空域的重排）——数据面板「无猜重排」行
       （2026-10-15 十期张老师定）与小雨伞抖动共用这一口径 */
    let ngSaves = 0;
    /* 3BV 范围（按级别独立记忆）：默认＝该级别完整统计区间；
       布雷时拒绝范围外盘面重掷（见 placeMines），最小差 10 由浮窗交互保证 */
    const bvSel: Record<string, { lo: number; hi: number }> = {};
    for (const k of Object.keys(bvRanges) as (keyof BvRanges)[]) {
      const r = bvRanges[k];
      bvSel[k] = { lo: r.min, hi: r.max };
    }
    /* localStorage 读取：解析失败/缺字段时静默用默认值（隐私模式同） */
    function loadSettings() {
      /* 移动端首次进入自动开启连击模式（2026-10-19 张老师定）：触屏设备（pointer:coarse）
         且从未进过练习页（标记键不存在）→ 自动打开；标记键保证只此一次，
         用户之后手动关掉也不会再被自动打开。
         ⚠️ 判断必须在最前（首次访问连存档都没有，下面 `!raw` 会提前 return），
         但**落盘必须在存档解析之后**——此刻 lv/bv/cus 还是挂载默认值，先写会把
         老用户存好的级别/3BV 区间整个冲掉 */
      let comboAuto = false;
      try {
        if (window.matchMedia("(pointer: coarse)").matches && !localStorage.getItem(COMBO_AUTO_KEY)) {
          combo = true;
          localStorage.setItem(COMBO_AUTO_KEY, "1");
          comboAuto = true;
        }
      } catch { /* 隐私模式：跳过自动开启 */ }
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) {
          if (comboAuto) saveSettings(); // 无存档：把 combo:true 连同默认设置一起落盘
          return;
        }
        const s = JSON.parse(raw) as {
          nf?: boolean; combo?: boolean; ng?: boolean; qmark?: boolean; bv?: Record<string, { lo: number; hi: number }>;
          showStats?: boolean; autoChord?: boolean; tips?: boolean;
          lv?: string;
          cus?: { w: number; h: number; m: number };
        };
        if (typeof s.nf === "boolean") nf = s.nf;
        if (typeof s.combo === "boolean") combo = s.combo;
        if (typeof s.ng === "boolean") ng = s.ng;
        if (typeof s.qmark === "boolean") qmark = s.qmark;
        if (typeof s.showStats === "boolean") showStats = s.showStats;
        if (typeof s.autoChord === "boolean") autoChord = s.autoChord;
        if (typeof s.tips === "boolean") tipsOn = s.tips;
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
      /* 自动开启压过存档旧值：上面解析会把 combo 恢复成存档里的 false（老用户从未
         开过连击），这里重新置真——触发过自动开启本次就生效，随后一并落盘 */
      if (comboAuto) combo = true;
      if (comboAuto) saveSettings(); // 有存档：解析完（级别/3BV 区间已恢复）再补写 combo:true
    }
    function saveSettings() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ nf, combo, ng, qmark, showStats, autoChord, tips: tipsOn, lv, bv: bvSel, cus: cusSpec }));
      } catch { /* 隐私模式 */ }
    }
    /* 上次级别（loadSettings 恢复；无记忆/脏数据回落 beg） */
    let savedLv = "";
    loadSettings();
    /* NF 与速旗互斥（2026-10-16 张老师定）：互斥上线前的存档可能两个同开，NF 优先 */
    if (nf && autoChord) autoChord = false;
    let mines: Uint8Array | null = null, nums: Uint8Array | null = null;
    let state: Uint8Array = new Uint8Array(0); // 0=block 1=open 2=flag 3=question
    let started = false, over = false, startTs = 0, timerId: number | null = null;
    let openedSafe = 0, totalSafe = 0, board3bv = 0;
    let pressCell: number | null = null, chordCells: number[] | null = null;
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
    /* ---- 对局统计（2026-10-16 重构）----
       废掉实时计数器（stLeft/stRight/stDouble/stCe/stPath + action() 包装）：
       结算统计改为对当局事件流跑共享重放引擎（lib/replay-core.ts replayCounts），
       与录像详情页/跑批同一事实源，口径永不分叉。
       事件录制按 flop/AVF 完整配对语义：lc/rc 按下即录（按下位坐标）、lr/rr 松开录
       （松开位坐标）、chord 首次松开生效、单击已开数字格录 sc+lr（计 Double）、
       自动双击录 mr。下载的 AVF 因此与站内引擎/Arbiter 全兼容。
       鼠标行程也走事件流口径（pathPx），与录像页一致。 */
    /** 把当局事件流转规范化事件，跑共享引擎得原始计数（结算时调一次） */
    function gameCounts(): ReplayCounts {
      const N = W * H;
      return replayCounts(
        { width: W, height: H, mines: M, board: mines ?? new Uint8Array(N) },
        evStream.map((e) => ({
          ev: MOUSE_CODE_TO_EV[e.mouse] ?? "mv",
          x: (e.x / 16) | 0,
          y: (e.y / 16) | 0,
          px: e.x,
          py: e.y,
        })),
        { marks: qmark }
      );
    }
    let bvRegions: number[][] = []; // 空格连通域（含边界数字格）
    let bvSingles: number[] = []; // 非空格区的数字格（3BV 单击格）
    let bvIslands: number[][] = []; // singles 的八连连通域（岛屿）
    /* 手势状态（2026-10-16 重构）：chord 按 flop 口径在**松开**生效——
       双键都按下后，松开任一键触发 chord 并录对应松开事件（lr 或 rr）；
       一键按住期间另一键**每次**点击都触发（按住右键连点左键＝连续双击，
       2026-10-18 张老师定），chordDone 只用于「一键已松、另一键后松」的闭合配对 */
    let leftDown = false, rightDown = false, chordDone = false;
    /* 连击手势动作标记：本次按下已产生过开格/插旗/chord 任一动作。
       连击「松开拔旗」只放行空手松开（见 window mouseup）——否则
       按下插旗后同格松开会把刚插的旗自己拔掉，滑动收尾压到旗上也会误拔 */
    let comboHit = false;

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
    /* 点遮罩关闭（卡片内部点击的 e.target 是卡片或其子节点，不会命中）。
       lsmax（高级/自定义横屏）除外：计数列整个隐藏＝笑脸开局钮不存在，点遮罩误关
       浮层后没有任何开新局入口（2026-10-15 张老师定）——收浮层只能走卡片上的
       「再来一局 / 重玩本局 / 查看回放」按钮 */
    on(grModal, "click", (e) => {
      if (container.classList.contains("op-lsmax")) return;
      if (e.target === grModal) hideResultModal();
    });

    /* ---- 结算快照（五期）：结束瞬间的完整对局状态，供重玩/回放/下载使用 ---- */
    interface GameSnapshot {
      w: number; h: number; m: number;
      mines: Uint8Array;
      bbbv: number;
      csec: number;           // 用时（百分秒）
      won: boolean;
      nf: boolean; combo: boolean; ng: boolean; qmark: boolean;
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
    /* 当前值顺手记账（二十期）：回放会征用计数条，退出回放要恢复结算终值 */
    let ledTimeCur = 0, ledMinesCur = 0;
    function led(el: SVGElement, v: number) {
      if (el === ledTime) ledTimeCur = v;
      else ledMinesCur = v;
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
        ngSaves++; // 触雷被救回＝1 次（面板「无猜重排」行）
        shakeModeBtn(btnNg); // 小雨伞抖一下（2026-10-15 十期张老师定）
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
    /* 模式快捷钮抖动提示（2026-10-15 十期张老师定）：NF 下右键抖 NF 钮
       （否则有人以为右键坏了）、无猜触雷救回抖雨伞钮。先摘类强制 reflow
       再挂回，连续触发也能重放；动画本体见 globals.css 的 op_shake */
    function shakeModeBtn(btn: HTMLElement) {
      btn.classList.remove("gshake");
      void btn.offsetWidth;
      btn.classList.add("gshake");
    }
    function toggleFlag(i: number) {
      if (over) return;
      if (state[i] === 1) return;
      /* 问号开关关：空白 ↔ 标雷 两态；开：空白 → 标雷 → 问号 三态循环 */
      if (state[i] === 0) state[i] = 2;
      else if (state[i] === 2) state[i] = qmark ? 3 : 0;
      else state[i] = 0;
      paint(i);
      led(ledMines, flagsLeft());
    }
    /* 「速旗模式」（2026-10-16 张老师定，NF 右侧小旗快捷钮，默认关）：插上旗后对周围
       已开数字格逐个预检——旗数恰好满足**且**有未开非旗邻格才执行 chord 并录 mr 事件
       （计一次 Double、开出格即有效）；空 chord 不执行不录制不计数 */
    function autoChordAround(i: number) {
      for (const a of neighbors(i)) {
        if (over || state[a] !== 1 || !nums || nums[a] === 0) continue;
        const around = neighbors(a);
        let f = 0;
        for (const c of around) if (state[c] === 2) f++;
        if (f !== nums[a]) continue;
        if (!around.some((c) => state[c] === 0)) continue;
        recordEv(65, a); // mr：程序触发的双击，引擎无条件计 Double（与手动 chord 同价）
        chord(a);
      }
    }
    /* 右键按下入口（桌面 mousedown；移动端长按不走这里）：
       速旗开＋点在已开数字上＝双击——录 mr（不录 rc：引擎里 rc 落在已开格会挂起 rv、
       随后的 rr 计一次 wasted 右键；mr 引擎无条件计 Double，与左键单击数字同口径）
       并直接 chord（chord 内部自守卫：旗数不满足/0 格不动作，同左键单击数字口径）；
       否则＝插旗（NF 下内部只抖动）+ 速旗自动 chord 联动 */
    function flagWithAutoChord(i: number) {
      if (autoChord && nums && state[i] === 1) {
        recordEv(65, i); // mr
        chord(i);
        return;
      }
      recordEv(9, i); // rc 按下即录——flop 插旗在按下位即刻生效
      toggleFlag(i);
      if (autoChord && state[i] === 2) autoChordAround(i);
    }
    /* ---- 连击模式单格动作（2026-10-19 张老师定，桌面鼠标与触屏轨迹共用） ----
       左击＝未开格开（录完整 lc+lr 对：按下即松，回放引擎 lr 才 flood，视觉只差一帧）、
       已开数字双击（sc+lr，与全局「单击已开数字格＝双击」同口径）；
       右击＝未开格插旗（录完整 rc+rr 对，按下位生效；速旗联动照走——
       点已开数字录 mr 不录 rc/rr、插旗成功后 autoChordAround）。
       旗/问号格按下不动作不录事件：连击是「插旗连发」，滑过已有旗不误拔；
       拔旗走松开路径——右键在旗格上**松开**＝取消标记（见 window mouseup，
       仅空手松开生效），事件流补 rc+rr 配对与常规右键同口径 */
    function comboLeftClick(i: number) {
      if (state[i] === 1) { comboHit = true; recordEv(11, i); recordEv(5, i); chord(i); }
      else if (state[i] === 0) { comboHit = true; recordEv(3, i); recordEv(5, i); openCell(i); }
    }
    function comboRightClick(i: number) {
      if (nf) return; // NF：右键禁用（入口已拦，双保险）
      if (autoChord && nums && state[i] === 1) { comboHit = true; recordEv(65, i); chord(i); return; }
      if (state[i] !== 0) return;
      comboHit = true;
      recordEv(9, i);
      toggleFlag(i);
      recordEv(17, i);
      const st: number = state[i]; // toggleFlag 改过盘面，取宽化副本供 速旗联动 判断
      if (autoChord && st === 2) autoChordAround(i);
    }
    /* ---- 结算报告（2026-10-14 张老师定：游戏结束时桌面版左侧浮窗，再开局隐藏；
       2026-10-15 六期改：显示时机交给设置开关「显示统计」，见 showStats）。
       公式与 flop player counters 逐项对齐（摘自其打包源码注释）：
       Est=RT×(3BV/solved)；IOE=solved/Cl；ThrP=solved/Ce；Corr=Ce/Cl；
       RQP=Est×(Est+1)/3BV；QG=RT^1.7/solved；
       STNB=(73.5L²−94.5L+57)/QG×(solved/3BV)^0.5（L: beg=1/int=2/exp=3；
       2026-10-16 难度常数更新为 初级36/中级162/高级435）；
       RTime 后缀 (n)=floor(RT)+1（录像秒数口径） */
    /* 表格 HTML + 完成 3BV（六期从 report 抽出：与结算共用同一份构造，口径永不分叉。
       八期起只在游戏结束这一刻渲染一次，不再有对局中刷新路径） */
    function statsReport(t: number, cnt: ReplayCounts): { solvedBv: number; html: string } {
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
      /* Cl/Ce/左右双/行程/旗数全部来自共享重放引擎（与录像详情页同一事实源） */
      const cl = cnt.clLeft + cnt.clRight + cnt.clDouble, ce = cnt.ce;
      const f3 = (v: number) => v.toFixed(3);
      const hasBv = solvedBv > 0 && t > 0;
      const est = hasBv ? t * (board3bv / solvedBv) : 0;
      const qg = hasBv ? Math.pow(t, 1.7) / solvedBv : 0;
      /* 评级难度档：自定义盘按雷密度映射（张老师 2026-10-15 定，见 ratingLevel 注释） */
      const rl = ratingLevel(lv, W, H, M);
      const ln = rl === "beg" ? 1 : rl === "int" ? 2 : 3;
      const stnb = hasBv
        ? (73.5 * ln * ln - 94.5 * ln + 57) / qg * Math.sqrt(solvedBv / board3bv)
        : 0;
      /* 玩家实际插的旗数＝重放终盘旗数（胜利自动补旗不进事件流，天然不含） */
      const playerFlags = cnt.flags;
      /* 每项第三列是 hover 气泡的解释（沿用 flop 原版 title 语义，中文一句话；含公式）。
         第四列可选＝数值格附加 class（「无猜重排」行用绿色） */
      const rows: [string, string, string, string?][] = [
        ["RTime", f3(t) + " (" + (Math.floor(t) + 1) + ")", "本局实际用时（秒），括号内为按秒进位的录像计分时间"],
        ["Est RTime", hasBv ? f3(est) + " (" + (Math.floor(est) + 1) + ")" : "* (*)", "按完成度折算的估算用时 = 实际用时 × 3BV ÷ 已完成 3BV"],
        ["3BV", solvedBv + "/" + board3bv, "盘面理论最少点击次数（Bechtel 基准值），显示为 已完成 / 全盘总量"],
        ["3BV/s", hasBv ? f3(solvedBv / t) : "*", "每秒完成的 3BV 数 = 已完成 3BV ÷ 实际用时，衡量操作效率"],
        ["Ops", solvedOps + "/" + bvRegions.length, "开空区域（opening）的完成数 / 全盘总数"],
        ["Isls", solvedIsls + "/" + bvIslands.length, "孤立数字块（island）的完成数 / 全盘总数"],
        ["Left", cnt.clLeft + "@" + (t > 0 ? f3(cnt.clLeft / t) : "0.000"), "左键点击次数 @ 每秒点击频率"],
        ["Right", cnt.clRight + "@" + (t > 0 ? f3(cnt.clRight / t) : "0.000"), "右键点击次数 @ 每秒点击频率"],
        ["Double", cnt.clDouble + "@" + (t > 0 ? f3(cnt.clDouble / t) : "0.000"), "双击（左右同按/单击数字/速旗）次数 @ 每秒频率"],
        ["Ce", ce + "@" + (t > 0 ? f3(ce / t) : "0.000"), "有效点击次数（真正开出新格或完成 3BV 的点击）@ 每秒频率"],
        ["Cl", cl + "@" + (t > 0 ? f3(cl / t) : "0.000"), "总点击次数（左键 + 右键 + 双击）@ 每秒频率"],
        ["IOE", cl > 0 ? f3(solvedBv / cl) : "*", "效率指数 = 已完成 3BV ÷ 总点击次数"],
        ["ThrP", ce > 0 ? f3(solvedBv / ce) : "*", "吞吐效率 = 已完成 3BV ÷ 有效点击次数"],
        ["Corr", cl > 0 ? f3(ce / cl) : "*", "准确率 = 有效点击 ÷ 总点击次数"],
        ["Path", String(Math.round(cnt.pathPx / 16)), "鼠标移动路径总长（按 16px/格折算的格数，与录像页口径一致）"],
        ["Flags", String(playerFlags), "玩家实际插旗数量（胜利时自动补的旗不计）"],
        ["RQP", hasBv ? f3((est * (est + 1)) / board3bv) : "*", "性价比 = 估算用时 × (估算用时 + 1) ÷ 3BV"],
        ["QG", hasBv ? f3(qg) : "*", "质量分 = 实际用时 ^ 1.7 ÷ 已完成 3BV"],
        ["STNB", hasBv ? f3(stnb) : "*", "无猜综合评分（按难度与完成度归一化，越大越好；自定义盘按雷密度折算难度）"],
      ];
      /* 无猜模式专属行（2026-10-15 十期张老师定）：绿色数值，hover＝触雷被救回次数 */
      if (ng) rows.push(["无猜重排", String(ngSaves), "触雷但通过重排挽救的次数", "gv_ng"]);
      const html =
        /* 关闭按钮已废（2026-10-15 张老师定）：面板收起只由设置浮窗「显示统计」开关
           或新局 reset 决定，面板右上角不放按钮 */
        '<div class="gr_title">数据统计</div>' +
        "<table>" +
        rows
          .map(
            (r) =>
              '<tr><td class="gt">' + r[0] + '</td><td class="gv' + (r[3] ? " " + r[3] : "") + '">' + r[1] + '<span class="tip">' + r[2] + "</span></td></tr>"
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
      /* 结算统计＝对当局事件流跑共享重放引擎（2026-10-16 重构）：面板/雷达/快照
         与「下载的 AVF 在录像页跑出的指标」同源，不再有两份计数实现 */
      const cnt = gameCounts();
      const { solvedBv, html } = statsReport(t, cnt);
      /* 练习局埋点（2026-10-16）：每局结束上报（胜/负都记），uid 服务端 session 取。
         sendBeacon 不阻塞下一局，关页/刷新也不丢；失败静默（埋点不影响游戏） */
      if (t > 0) {
        try {
          const payload = JSON.stringify({
            level: lv, won, csec: Math.round(t * 100), bbbv: board3bv,
            solvedBv, nf, clicks: cnt.clLeft + cnt.clRight + cnt.clDouble,
          });
          navigator.sendBeacon("/api/track/practice", new Blob([payload], { type: "application/json" }));
        } catch { /* ignore */ }
      }
      /* 数据面板只在「显示统计」开着时、且只在**游戏结束**这一刻出现
         （2026-10-15 八期张老师定：对局中不再常驻实时刷新）；再开局由 reset 撤下。
         十期补：无论开关与否都定格一份 HTML，供局后补开开关时立即补弹本局面板 */
      lastReportHtml = html;
      if (showStats) paintStatPanel(html);
      buildResultPanel(t, solvedBv, won, cnt);
    }
    /* ---- 右侧结算面板（五期）：雷达图 + 再来一局 / 重玩本局 / 查看回放 / 下载录像 ---- */
    function buildResultPanel(t: number, solvedBv: number, won: boolean, cnt: ReplayCounts) {
      const cl = cnt.clLeft + cnt.clRight + cnt.clDouble, ce = cnt.ce;
      const path = Math.round(cnt.pathPx / 16); // 行程折「格」（16px/格），与录像页同量纲
      const hasBv = solvedBv > 0 && t > 0;
      const qg = hasBv ? Math.pow(t, 1.7) / solvedBv : 0;
      /* 评级难度档：自定义盘按雷密度映射（与 statsReport / computeRadarPoints 同一口径） */
      const rl = ratingLevel(lv, W, H, M);
      const ln = rl === "beg" ? 1 : rl === "int" ? 2 : 3;
      const stnb = hasBv
        ? (73.5 * ln * ln - 94.5 * ln + 57) / qg * Math.sqrt(solvedBv / board3bv)
        : 0;
      snapshot = {
        w: W, h: H, m: M,
        mines: mines ? mines.slice() : new Uint8Array(0),
        bbbv: board3bv,
        csec: Math.round(t * 100),
        won,
        nf, combo, ng, qmark,
        level: lv,
        events: evStream.slice(),
        dateStr: formatAvfTimestamp(new Date()),
        stats: {
          solvedBv, cl, ce, stnb,
          bvs: hasBv ? solvedBv / t : 0,
          ioe: cl > 0 ? solvedBv / cl : 0,
          corr: cl > 0 ? ce / cl : 0,
          cls: t > 0 ? cl / t : 0,
          /* ppc 单位＝格/击（2026-10-16 修：此前误用 px/击，比录像页口径大 16 倍，
             雷达「移动」轴分位一直按错单位评） */
          ppc: cl > 0 ? path / cl : 0,
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
         十一期追补（2026-10-15 张老师定）：「未完成」后附**预计完成用时**——
         括号 + 小一号字号 + 亮灰（#b1b1a4），口径与数据面板 Est RTime 一致
         （实际用时 × 3BV ÷ 已完成 3BV）；无完成量（首击即雷）时不显示。
         右＝「评级：S+」——五围图各轴组内分位的加权新评级（STNB 占一半、四分项各 1/8，
         权值见 lib/videoscore.ts PERFORMANCE_WEIGHTS）。
         无法评级（缺基准 / 完成度过低 / 无点击）时评级显示「—」 */
      const pts = computeRadarPoints(s);
      /* 综合评级走共享件（2026-10-16）：五轴组内分位加权，全屏试玩「我的评级」同一份算法 */
      const perfGrade = radarOverall(pts);
      const lvName = (LEVEL_NAMES as Record<string, string>)[s.level] ?? "自定义";
      /* 预计完成用时（十一期）：Est RTime 同口径，半角括号整体小号亮灰 */
      const estSec = s.stats.solvedBv > 0 ? (s.csec / 100) * (s.bbbv / s.stats.solvedBv) : 0;
      const lvSpan = s.won
        ? '<span class="gr_lv">' +
          lvName +
          '<em class="lv_' + s.level + '">' + (s.csec / 100).toFixed(2) + "</em>秒" +
          (s.nf ? "<ins>NF</ins>" : "") +
          (s.combo ? "<ins>连击</ins>" : "") +
          "</span>"
        : '<span class="gr_lv fail">未完成' +
          (estSec > 0
            ? '<span class="est">(预计 ' + estSec.toFixed(2) + "秒)</span>"
            : "") +
          "</span>";
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
      /* 雷达图恒显示（2026-10-15 张老师定）：自定义盘参照高级基准评级；
         缺基准 / 完成度过低 → 空雷达（全轴 ?、收缩到圆心），hover 提示「参考数据不足，无法评级」 */
      const radarHost = host.querySelector("#gr_radar") as HTMLElement | null;
      if (radarHost) {
        radarHost.style.display = "block";
        /* 复用录像详情页的 VideoAnalysisRadar 组件（张老师 2026-10-14 定：不该再维护第二份
           绘制）。面板是 innerHTML 注入流、JSX 挂不进去，所以用 createRoot 把 React 组件挂到
           占位 div —— 文案/字号/气泡样式与录像页**由同一个组件保证同源**，不会再分叉。
           fill 模式（八期 2026-10-15 张老师定）：宽度顶满面板内容宽，不再给固定边长 */
        const root = createRoot(radarHost);
        root.render(<VideoAnalysisRadar data={pts} fill />);
        radarRootRef.current = root;
      }
      /* 显形后立刻定位缩放：数据面板关着时 syncReportZoom 不再被 paintStatPanel 带动
         （那是「面板小、叠棋盘左上」bug 的另一半——游戏结束这刻也无人调用）。
         雷达是 createRoot 异步渲染、首帧量不到高度，再排一帧复核；数据面板开着时
         重复算一遍值相同，无害 */
      syncReportZoom();
      requestAnimationFrame(syncReportZoom);
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
       不同级别不通比）。
       自定义盘先经 ratingLevel 按雷密度折算难度档（2026-10-15 十四期张老师定，见下），
       再按折算后的级别查基准分布——STNB 难度系数与基准组同步切换。
       无法评级（缺基准 / 无点击 / 完成度 < 10%，2026-10-14 张老师定）→ **不再隐藏雷达**，
       显示空雷达：全轴 grade="?"、percent=0（多边形收缩到圆心），hover 提示
       「参考数据不足，无法评级」——开局即死的局没有评价意义，但图本身要一直在。
       ⚠️ 口径与录像详情页**完全同源**：五围 + 综合=STNB 组内分位，全部走 lib/videoscore.ts，
          不要在这里再写一份（2026-10-14 之前这里有本地副本，主模块改了副本没跟上，两边评级分叉） */
    /* 自定义盘的评级难度档（2026-10-15 十四期张老师定）：上一版 cus 一律按高级（ln=3），
       雷密度稀疏的盘（如 9×9·4）3BV/用时比天然华丽，STNB 轻松破高级满档 252.7 → 满屏 SSS。
       改为按**雷密度** m/(w·h) 映射到最接近的标准级别，STNB 难度系数与基准组同步切换：
       锚点＝标准级别雷密度 beg/int 15.6%、exp 20.6%；
       ≥18% 按高级、13–18% 按中级、<13% 按初级（9×9 小盘同密度仍按初级——盘小操作量小）。
       实证（本地基准）：3BV=7/4.19s 稀疏局 ln=3→STNB 266（exp SSS 爆表），
       ln=1→STNB 28.9（beg C 档，符合直觉）。阈值要调直接改 0.18 / 0.13 */
    function ratingLevel(lv: string, w: number, h: number, m: number): string {
      if (lv !== "cus") return lv;
      const d = m / (w * h);
      if (d >= 0.18) return "exp";
      if (d >= 0.13 && w * h > 81) return "int";
      return "beg";
    }
    function computeRadarPoints(s: GameSnapshot): VideoAnalysisPoint[] {
      const distLevel = ratingLevel(s.level, s.w, s.h, s.m);
      /* NF 局走 _nf 基准分布（无右键行程的指标形态与常规局不同）；连击局与常规局同分布 */
      const group = metricDists[distLevel + (s.nf ? "_nf" : "")]?.[String(DIST_BUCKET_ALL)];
      const lowCompletion = s.bbbv <= 0 || s.stats.solvedBv / s.bbbv < 0.1;
      const rateable = !!group && !!s.stats.cl && !lowCompletion;
      /* 五轴组装走 lib/videoscore.ts 的共享件（2026-10-16 起）：录像详情页右栏、
         本结算面板、全屏试玩「我的评级」三处同一份实现，口径不再各写一遍 */
      return radarPointsFrom(s.stats, group, rateable);
    }
    /* AVF 时间戳格式（Arbiter 惯例）：M.D.YYYY.HH:MM:SS:mmmm */
    function formatAvfTimestamp(d: Date): string {
      const p2 = (n: number) => String(n).padStart(2, "0");
      return `${d.getMonth() + 1}.${d.getDate()}.${d.getFullYear()}.${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}:${String(d.getMilliseconds()).padStart(4, "0")}`;
    }
    /* ---- 重玩本局：完全复刻结束时的地图，强制关闭无猜（张老师定：重玩盘面必须原样） ---- */
    function replaySameBoard() {
      if (!snapshot) return;
      /* 无猜开关强制关闭（本局内 ng 生效即关闭；快捷钮同步熄灭） */
      if (ng) {
        ng = false;
        syncModeButtons();
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
        nf: snapshot.nf, // NF 局文件名带 NF 段（连击局不禁旗、不带）
        bbbv: snapshot.bbbv,
        user: player, // 未登录为 null → 文件名省略 `# 用户ID 英文名` 段
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      /* 局中绿色气泡反馈（2026-10-19 张老师定）：确认下载动作已完成 */
      showToast("下载成功");
    }
    /* ---- 自研回放（五期二版，2026-10-14 张老师定：不弹窗，就在游戏界面进行；
       六期 2026-10-15 撤掉控制栏；二十期 2026-10-16 张老师定：控制条回归——
       与录像详情页 ReplayBar 同款（无全屏按钮），计数条（计时/雷数 LED）随回放实时同步）----
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
    /* 回放控制条宽度同步钩子（二十期）：条挂 #game_area、宽跟 gwrap 渲染宽走——
       setZoomVisual 每次变倍调用（startInPlaceReplay 注册、exitReplay 自清） */
    let syncReplayBarWidth: (() => void) | null = null;
    function startInPlaceReplay() {
      if (!snapshot) return;
      /* 已在回放中（六期张老师定）：不忽略点击，从头重播 */
      if (replaying) { restartReplay?.(); return; }
      /* 移动端（七期）：回放在游戏盘面上演，结算浮层（带遮罩）挡着盘面——点「查看回放」
         即收起浮层，播完再弹回来（见 exitReplay / tick 的收尾） */
      hideResultModal();
      const s = snapshot;
      /* 结算终值存档（二十期）：回放期间计数条被征用（计时/雷数 LED 随回放走），
         退出回放恢复到这里存的读数；倍率同理——若为装下控制条自动缩小过，
         退出时还原（玩家回放中手动动过倍率则尊重现状不还原） */
      const savedTimeLed = ledTimeCur, savedMinesLed = ledMinesCur;
      const savedZoom = zoomCur;
      let shrankTo: number | null = null;
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
      /* 回放状态机（0=未开 1=开 2=旗 3=问号），直接写游戏盘面贴图：
         td 类名走 VEC_MAP 语义（bb/b1…/bf/bq），vecUse 同步切换——与引擎 paint 同管线 */
      const rstate = new Uint8Array(N);
      function paintR(i: number) {
        const td = tbody.rows[(i / s.w) | 0].cells[i % s.w];
        let cls = "bb";
        if (rstate[i] === 1) cls = "b" + nums[i];
        else if (rstate[i] === 2) cls = "bf";
        else if (rstate[i] === 3) cls = "bq";
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
         渲染尺寸 12×19 = viewBox 的 1/10，尖端显示像素 ≈ (0.5,1.21)
         （此前误按 viewBox 坐标整像素减，尖端扎在格子左上角——2026-10-15 张老师报）。
         容器左上角偏移 (-0.5,-1.21)，渲染尺寸 12×19（一格量级，flop 原版视觉） */
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
      /* 尖端锚点：箭头尖端显示像素 (0.5,1.21) 对准事件坐标——left/top 直接写偏移后的值
         （1x 像素坐标系内偏移固定；CSS margin 在 zoom 下的缩放语义不可靠，弃用） */
      const TIP_X = 0.5, TIP_Y = 1.21;
      function moveCursor(px: number, py: number) {
        curEl.style.left = px + gboardOff.x - TIP_X + "px";
        curEl.style.top = py + gboardOff.y - TIP_Y + "px";
      }
      /* 回放事件应用（2026-10-16 重写）：与新录制方言 / flop 状态机同语义——
         lc/rc 只记按下（rc 按下即刻切旗，lp 按住下仅视觉），
         lr/rr 松开生效（rp||sv 下＝双击），sc 等后续 lr，mr（自动双击）无条件 chord */
      let rLp = false, rRp = false, rSv = false;
      let rFlags = 0; // 已插旗数（雷数 LED＝s.m − rFlags，随回放实时同步）
      function applyEv(k: number) {
        const e = evs[k];
        moveCursor(e.x, e.y);
        const cx = (e.x / 16) | 0, cy = (e.y / 16) | 0;
        const inside = cx >= 0 && cx < s.w && cy >= 0 && cy < s.h;
        const ci = cy * s.w + cx;
        switch (e.mouse) {
          case 3: rLp = true; break; // lc
          case 5: // lr
            if (inside) { if (rRp || rSv) chordR(ci); else floodR(ci); }
            rLp = false; rSv = false;
            break;
          case 9: // rc
            if (!rLp && inside) {
              if (rstate[ci] === 0) { rstate[ci] = 2; rFlags++; paintR(ci); }
              else if (rstate[ci] === 2) { rstate[ci] = s.qmark ? 3 : 0; rFlags--; paintR(ci); }
              else if (rstate[ci] === 3) { rstate[ci] = 0; paintR(ci); }
            }
            rRp = true;
            break;
          case 17: // rr：lp 按住＝双击
            if (rLp && inside) chordR(ci);
            rRp = false;
            break;
          case 11: rLp = true; rSv = true; break; // sc：单击数字格 chord，等 lr
          case 65: if (inside) chordR(ci); break; // mr：自动双击
          default: break; // mv
        }
      }
      /* ---- 播放控制条（二十期 2026-10-16 张老师定，六期「撤条」口径作废）----
         与录像详情页 ReplayBar 同款：复用 .replay_bar/.rb_* 全局样式（globals.css），
         无全屏按钮。播放/暂停 + 当前时间 + 可拖拽进度条；拖拽＝按住即暂停（记住
         原播放态）、拖动中按帧 seek 实时预览、松手定位续播；拖到最右停在结束那一刻
         不自动续播（重播语义留给播放按钮——ended 态点播放＝从头重播）。
         横屏沉浸 / 移动端全屏拉满态不挂条：这两种形态棋盘恰好铺满视口，流内条会被
         整页锁滚裁出视口（fsAutoFit / fitZoomForLandscape 口径）；回放仍自动播完、
         移动端播完自动退出，退出入口照旧。条挂 #game_area（gwrap 之后的流内子元素，
         不吃游戏 zoom），宽度跟 gwrap 渲染宽走（十二期「控制条与棋盘同宽」口径），
         setZoomVisual 变倍时经 syncReplayBarWidth 钩子重算。
         ⚠️ 切级别自动适配把棋盘拉满到视口底−12px，条必然出视口——挂载后量一次，
         装不下就临时缩小倍率（persist=false 不写盘），退出回放还原（见 exitReplay） */
      const barOk = !(lsQuery.matches || (mqNarrow.matches && !!document.fullscreenElement));
      let bar: HTMLDivElement | null = null;
      let fillEl: HTMLElement | null = null, thumbEl: HTMLElement | null = null,
          timeEl: HTMLElement | null = null;
      let syncBtnFn: (() => void) | null = null;
      if (barOk) {
        bar = document.createElement("div");
        bar.className = "replay_bar";
        const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
        const ICON_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4.8v14.4c0 .9 1 1.45 1.76.96l9.6-7.2a1.14 1.14 0 0 0 0-1.92l-9.6-7.2A1.14 1.14 0 0 0 7 4.8z"/></svg>';
        bar.innerHTML =
          '<button type="button" class="rb_btn" title="暂停" aria-label="暂停">' + ICON_PAUSE + "</button>" +
          '<span class="rb_time">0.00</span>' +
          '<div class="rb_track" title="拖动跳转进度"><div class="rb_rail"><div class="rb_fill"></div><div class="rb_thumb"></div></div></div>';
        const btnEl = bar.querySelector<HTMLButtonElement>(".rb_btn")!;
        timeEl = bar.querySelector<HTMLElement>(".rb_time")!;
        fillEl = bar.querySelector<HTMLElement>(".rb_fill")!;
        thumbEl = bar.querySelector<HTMLElement>(".rb_thumb")!;
        const railEl = bar.querySelector<HTMLElement>(".rb_rail")!;
        const trackEl = bar.querySelector<HTMLElement>(".rb_track")!;
        /* 宽度＝gwrap 渲染宽；页面局部 px = 渲染 rect ÷ 页级 zoom（#page 窄屏阶梯缩放） */
        const syncWidth = () => {
          if (!bar) return;
          bar.style.width = gwrap.getBoundingClientRect().width / pageZoom() + "px";
          bar.style.marginLeft = bar.style.marginRight = "auto"; // 块级定宽后居中对齐银框
        };
        syncWidth();
        /* 窄盘条按 min-width 向两侧延展 + 左右结算浮窗（greport z=5）比银框高——
           条抬到浮窗之上，保证播放按钮不被压（视觉上只压到浮窗底行边缘几px） */
        bar.style.zIndex = "6";
        syncReplayBarWidth = syncWidth;
        gwrap.parentElement!.appendChild(bar);
        /* 播放/暂停按钮（ended 态点播放＝从头重播，setPlaying 内处理） */
        syncBtnFn = () => {
          btnEl.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
          btnEl.title = playing ? "暂停" : "播放";
          btnEl.setAttribute("aria-label", playing ? "暂停" : "播放");
        };
        btnEl.addEventListener("click", () => setPlaying(!playing));
        /* 进度拖拽（按帧合并 seek：pointermove 频率高于帧率，逐事件重放白费） */
        let dragActive = false, dragWasPlaying = false, dragRaf = 0, dragCsec = 0;
        const posToCsec = (clientX: number) => {
          const r = railEl.getBoundingClientRect();
          const ratio = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
          return Math.round(ratio * s.csec);
        };
        const seekFrame = (clientX: number) => {
          dragCsec = posToCsec(clientX);
          if (!dragRaf) {
            dragRaf = requestAnimationFrame(() => { dragRaf = 0; seekTo(dragCsec); });
          }
        };
        trackEl.addEventListener("pointerdown", (e) => {
          dragActive = true;
          dragWasPlaying = playing;
          if (dragWasPlaying) setPlaying(false);
          trackEl.setPointerCapture(e.pointerId);
          seekFrame(e.clientX);
        });
        trackEl.addEventListener("pointermove", (e) => { if (dragActive) seekFrame(e.clientX); });
        const endDrag = (clientX: number | null) => {
          if (!dragActive) return;
          dragActive = false;
          if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
          const csec = clientX === null ? dragCsec : posToCsec(clientX);
          seekTo(csec);
          /* 拖到最右＝停在结束那一刻（十三期口径）：不 resume */
          if (dragWasPlaying && csec < s.csec) setPlaying(true);
        };
        trackEl.addEventListener("pointerup", (e) => endDrag(e.clientX));
        trackEl.addEventListener("pointercancel", () => endDrag(null));
        /* 拉满倍率兜底：等一帧布局落定后量条，出视口即临时缩小倍率装下 */
        requestAnimationFrame(() => {
          if (!bar || !replaying) return;
          const br = bar.getBoundingClientRect();
          const vh = window.innerHeight;
          if (br.height > 0 && br.bottom > vh - 4) {
            const gwR2 = gwrap.getBoundingClientRect();
            /* 可用银框底 = 视口底 − 4 余量 − 条渲染高 − 条 margin-top 8 */
            const scale = (vh - 4 - br.height - 8 - gwR2.top) / (gwR2.bottom - gwR2.top);
            const nz = zoomCur * scale;
            if (nz > 0.2 && nz < zoomCur) {
              const zBefore = zoomCur;
              applyZoom(nz, false);
              if (zoomCur < zBefore) shrankTo = zoomCur; // 被 floor 钳住没缩成则不记
            }
          }
        });
      }
      let evIdx = 0;
      let curCsec = 0;
      let playing = false;
      let rafId: number | null = null;
      let lastFrame = 0;

      /* 计数条同步（二十期）：计时 LED 走回放时钟（整秒），雷数 LED＝总雷−已插旗 */
      function updateCounters() {
        led(ledTime, Math.min(999, Math.floor(curCsec / 100)));
        led(ledMines, s.m - rFlags);
      }
      /* 控制条进度同步（二十期）：填充/滑块百分比 + 当前时间文本 */
      function syncBarUI() {
        const pct = s.csec > 0 ? Math.max(0, Math.min(1, curCsec / s.csec)) * 100 : 0;
        if (fillEl) fillEl.style.width = pct.toFixed(2) + "%";
        if (thumbEl) thumbEl.style.left = pct.toFixed(2) + "%";
        if (timeEl) timeEl.textContent = (curCsec / 100).toFixed(2);
      }

      function setPlaying(v: boolean) {
        playing = v;
        syncBtnFn?.();
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
        rLp = rRp = rSv = false; // 手势状态机一并归零（重播/拖动进度时）
        rFlags = 0;
        for (let i = 0; i < N; i++) paintR(i);
        evIdx = 0; curCsec = 0;
        moveCursor(0, 0);
        updateCounters();
        syncBarUI();
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
        updateCounters();
        syncBarUI();
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
        updateCounters();
        syncBarUI();
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
        syncReplayBarWidth = null;
        curEl.remove();
        bar?.remove(); // 控制条随回放退出一并撤掉（二十期）
        /* 恢复结算盘面（repaintAll 按引擎 state 重画，含败局雷区揭示）；
           reset 路径传 false（后面自会全盘重画） */
        if (repaint) {
          repaintAll();
          /* 计数条恢复结算终值（二十期）：计时/雷数 LED 归还为回放征用前的读数；
             reset 路径不还——reset 开头自会 led(ledMines, M) / led(ledTime, 0) */
          led(ledTime, savedTimeLed);
          led(ledMines, savedMinesLed);
          /* 回放开始时为装下控制条自动缩小过倍率 → 还原（玩家回放中手动动过
             倍率则 zoomCur ≠ shrankTo，尊重现状） */
          if (shrankTo !== null && zoomCur === shrankTo) applyZoom(savedZoom, false);
        }
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
    /* 高级/自定义横屏最大化（2026-10-15 张老师五定）：去掉极简模式开关，改为
       移动端高级和自定义横屏时直接不显示时间笑脸区、游戏边框收细（CSS 横屏块
       .op-lsmax 门控）。类挂在组件根 div 上——随组件卸载自动消失，无需清理；
       初级/中级不带类，保持带框经典形态。gbar 显隐会改 gwrap 基准尺寸，
       状态翻转必须发生在 fit 量测之前——调用点：reset（级别变化）与
       syncLandscape（旋转进出横屏），都先于各自的 fitZoomForLandscape */
    function syncLsMax() {
      container.classList.toggle("op-lsmax", lsQuery.matches && (lv === "exp" || lv === "cus"));
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
      /* 手势状态清零 + 隐藏结算报告（张老师：游戏再次开始时隐藏）；事件流同步清空
         （五期）；重玩锁定标记保留——placeMines 在首击时消费它 */
      leftDown = rightDown = chordDone = false;
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
      ngSaves = 0;
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
      /* 高级/自定义横屏最大化：先落 .op-lsmax 类（gbar 显隐/边框收细）再量测，
         否则 fit 拿到的是旧基准 */
      syncLsMax();
      if (document.fullscreenElement === root) fitZoomForFullscreen();
      else if (lsQuery.matches) fitZoomForLandscape();
      else if (gridChanged) {
        if (lv !== prevLv) {
          /* 切标准级别（beg/int/exp，2026-10-15 张老师定）：自动适配「可显示的
             最大尺寸比例」——宽×高都装得下的最大倍率，不再原样套用上一级别
             留下的 online_play_zoom 记忆（初级拉满切中级溢出屏幕底的根因）。
             persist=false 不写盘：记忆键保留给手动拖滑杆，刷新/再次进页仍按它恢复
             （加载时同样会被高度封顶钳住，不会溢出）。cus 维持记忆/1x 起步 */
          if (lv === "cus") applyModeZoom();
          else applyZoom(normalMaxZoom(), false);
        } else applyZoom(zoomCur, false);
      }
      /* 数据面板常驻时（六期）重开后盘面尺寸/倍率可能已变，重新对齐+缩放 */
      if (showStats) syncReportZoom();
      /* 开局 tips（2026-10-19 张老师定）：每局一条、当天不重复（showTip 内部自判
         开关/已显记录，全出过或开关关闭则本局静默） */
      showTip();
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
       记忆只在用户手动拖滑杆/重置时更新。
       ⚠️ 2026-10-15 起 reset 里标准级别切换不再走本函数（改为直接
       applyZoom(normalMaxZoom()) 自动适配最大可显示，见 reset 注释）；
       本函数只剩两处调用：首次加载（2828 附近）与切入 cus */
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
    /* 版式恒定（v8）：#page 宽度始终与 header 一致（62%/min620/max960），不再随
       自定义盘面伸缩——v7 的「页宽跟随盘面」（syncPageFit）及其配套的拖动冻结
       （cusDragging）、拖动中 range 滑轨横移振荡问题整体废除。规格滑杆拖动期间
       页宽不动，弹窗锚位也不会变，无需任何重对准钩子 */
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
    /* 宽/高滑杆拖动（v8）：页宽恒定后拖动中无版式联动，input 即时重建盘面即可，
       无需冻结/松手钩子（v7 的 cusDragging 机制已废） */
    /* 比例滑杆交互（弹窗内 v7 张老师 19:07 / 设置浮窗二期那张同源）：
       拖动中只改渲染倍率（setZoomVisual，不封顶不写盘）——页宽一变，居中板块里的
       滑轨就横移，range 会把同一点点位换算成别的值（v6 振荡同源），故拖动中页宽冻结；
       松手（pointerup/change，双保险：拖到端点值不变时 change 不触发）再由 applyZoom
       按视口上限正式定值 + 写记忆（v8：页宽恒定，滑轨不再横移，此顾虑仅存于
       拖动中不封顶的既有语义） */
    function zoomDragInput(v: number) {
      zoomBeforeFs = null; // 手动调比例 → 以手动为准，退出全屏/横屏不再自动恢复
      zoomBeforeLs = null;
      if (lsQuery.matches) lsManual = true; // 横屏中手动调过 → resize/复核兜底不再覆盖手动值
      zoomWant = v;
      setZoomVisual(v);
    }
    function zoomDragEnd() {
      applyZoom(zoomWant); // 按视口上限封顶 + 落盘
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

    /* ---- 设置浮窗内开关：问号只改右键循环。NF/无猜两项已于十期撤出设置
       （入口收敛到模式快捷钮 btnCombo/btnNg，见下方九期块） ---- */
    const swQm = $("sw_qm") as HTMLInputElement;
    const swStats = $("sw_stats") as HTMLInputElement;
    const swTips = $("sw_tips") as HTMLInputElement;
    on(swQm, "change", () => { qmark = swQm.checked; saveSettings(); });
    /* 「显示统计」（八期改口径）：只影响**游戏结束**时是否弹出数据面板，不重开当前局。
       打开时对局中不提前出现；关闭时若上一局定格的面板还挂着，立刻撤下。
       十期补（2026-10-15 张老师定）：游戏已结束（面板当时没弹）再打开开关 →
       用 report 定格的 HTML **立即补弹当前这局的面板**；对局中打开则等本局结束再弹 */
    on(swStats, "change", () => {
      showStats = swStats.checked;
      saveSettings();
      if (!showStats) {
        greport.classList.remove("show");
        return;
      }
      if (over && lastReportHtml) paintStatPanel(lastReportHtml);
    });
    /* 「开局提示」开关：只管开局技巧气泡（showTip），不影响局中通知气泡（showToast）；
       切换不重开当前局 */
    on(swTips, "change", () => { tipsOn = swTips.checked; saveSettings(); });
    /* ---- 模式快捷钮（2026-10-15 九期张老师定）：设置按钮左侧 NF／速旗／连击／无猜四颗 ----
       激活显色（NF=绿 #a6e22e（2026-10-19 张老师定）/ 无猜=绿 / 速旗=默认黄 / 连击=默认黄）、
       未激活灰。NF／无猜点击＝把内存开关取反 → saveSettings → 重开一局；
       速旗/连击只影响之后的操作行为，切换不重开当前局（原「自动双击」开关口径）。
       NF 与速旗互斥（2026-10-16 张老师定，NF 恢复后继续沿用）：打开其一自动关闭另一者；
       NF 切换重开（禁右键改变对局语义）；速旗被顶掉时 NF 开启中 → 同步重开。
       连击与速旗**不互斥**（2026-10-19 张老师定，可叠加）。
       十期起设置浮窗里不再有 NF/无猜两项（行已删），快捷钮是唯一入口；
       「自动双击」设置开关同期撤出，改挂速旗快捷钮 */
    const btnNf = $("btn_nf") as HTMLButtonElement;
    const btnSq = $("btn_sq") as HTMLButtonElement;
    const btnCombo = $("btn_combo") as HTMLButtonElement;
    const btnNg = $("btn_ng") as HTMLButtonElement;
    function syncModeButtons() {
      btnNf.classList.toggle("active", nf);
      btnSq.classList.toggle("active", autoChord);
      btnCombo.classList.toggle("active", combo);
      btnNg.classList.toggle("active", ng);
    }
    on(btnNf, "click", () => {
      nf = !nf;
      if (nf && autoChord) autoChord = false; // 互斥：开 NF 自动关速旗
      saveSettings();
      syncModeButtons();
      reset();
    });
    on(btnSq, "click", () => {
      autoChord = !autoChord;
      /* 互斥：开速旗自动关 NF——NF 被顶掉时对局禁右键语义已失效，须重开；
         单纯切速旗（未顶掉 NF）仍不重开 */
      if (autoChord && nf) {
        nf = false;
        reset();
      }
      saveSettings();
      syncModeButtons();
    });
    /* 连击切换不重开（2026-10-19 张老师定）：它只改「按下即触发＋滑动连点」的
       交互方式，不改变盘面规则/旗语义，对局中途切换无一致命状态 */
    on(btnCombo, "click", () => {
      combo = !combo;
      saveSettings();
      syncModeButtons();
    });
    on(btnNg, "click", () => {
      ng = !ng;
      saveSettings();
      syncModeButtons();
      reset();
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
      if (entered) {
        zoomBeforeFs = zoomCur;
        // 等全屏渲染稳定（innerWidth 更新为屏幕尺寸）后再测量计算
        window.setTimeout(() => { if (document.fullscreenElement === root) fitZoomForFullscreen(); }, 80);
      } else if (zoomBeforeFs !== null) {
        applyZoom(zoomBeforeFs, false);
        zoomBeforeFs = null;
        /* 退出全屏后仍在横屏自动模式：按视口高度重新拉满 */
        if (lsQuery.matches && !lsManual) fitZoomForLandscape();
      }
    });
    /* 全屏中旋转屏幕等尺寸变化时重新拉满；横屏自动模式下浏览器栏显隐同理；
       普通模式下窗口变窄也重新封顶，避免游戏区冲出 #page 版块 */
    window.addEventListener("resize", () => {
      if (document.fullscreenElement === root) fitZoomForFullscreen();
      else if (lsQuery.matches && !lsManual) fitZoomForLandscape(); // 首帧横屏（zoomBeforeLs 恒 null）也要兜底，故只看 lsManual
      else applyZoom(zoomCur, false);
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
      /* 连击模式按下即触发（2026-10-19 张老师定，承 NF 按下即开口径）：
         左键按下＝完整一次点击、右键按下＝完整一次右击（见 comboLeftClick/comboRightClick），
         按住滑动逐格触发（见 mouseover），松开不补录任何事件（配对在触发时已闭合，
         见 window mouseup）。双键同按无 chord 手势语义——两键各自即时生效 */
      if (combo && e.button === 0) {
        leftDown = true; rightDown = false; chordDone = false; comboHit = false;
        setFace("ooh");
        comboLeftClick(i);
        return;
      }
      if (combo && e.button === 2) {
        if (nf) { shakeModeBtn(btnNf); return; } // NF：右键禁用（连击只保留左键连开）
        rightDown = true; leftDown = false; chordDone = false; comboHit = false;
        setFace("ooh");
        comboRightClick(i);
        return;
      }
      if (e.buttons === 3) { // 左右同按 = 双击手势（第二键并入，只录按下事件不动作）
        clearPress();
        pressAround(i);
        setFace("ooh");
        if (e.button === 2) { rightDown = true; recordEv(9, i); } // rc：lp 按住下仅视觉（引擎不插旗）
        else { leftDown = true; recordEv(3, i); } // lc：rp 按住下等松开判双击
      } else if (e.button === 0) {
        leftDown = true; rightDown = false; chordDone = false; // e.buttons=1：顺带自愈旧手势残留
        recordEv(3, i); // lc 按下即录（按下位坐标，flop/AVF 口径）
        pressSingle(i);
        setFace("ooh");
      } else if (e.button === 2) {
        if (nf) { shakeModeBtn(btnNf); return; } // NF 模式：右键禁用，只抖钮反馈、不录事件
        rightDown = true; leftDown = false; chordDone = false; // e.buttons=2：同上自愈
        flagWithAutoChord(i); // rc 录制收进内部：速旗下点已开数字录 mr+chord，否则录 rc 插旗
      }
    });
    /* 按住滑动：按下态实时跟随鼠标经过的格子（出盘后再进盘按 e.buttons 自愈） */
    on(gboard, "mouseover", (e: MouseEvent) => {
      if (over || gameBusy()) return;
      /* 手势残留自愈：松开发生在浏览器窗口外时 window mouseup 捕不到，
         空手（buttons=0）划回棋盘说明手势早已结束 */
      if (e.buttons === 0 && (leftDown || rightDown)) { leftDown = rightDown = chordDone = false; }
      const i = eventCell(e); if (i < 0) return;
      /* 连击模式滑动连点（2026-10-19 张老师定）：按住左键（含双键同按）滑过未开格
         即开、只按右键滑过未开格即插旗——comboLeftClick/comboRightClick 内部按
         state 守卫，「一格限一次」天然成立（触发过 state 变更即不会再中）；
         无需按下态高亮（动作瞬时完成） */
      if (combo) {
        if (leftDown) { setFace("ooh"); comboLeftClick(i); }
        else if (rightDown) { setFace("ooh"); comboRightClick(i); }
        return;
      }
      if (e.buttons === 3) {
        if (pressCell !== null) { if (state[pressCell] === 0) paint(pressCell); pressCell = null; }
        pressAround(i);
        setFace("ooh");
      } else if (e.buttons === 1) {
        if (chordCells) { chordCells.forEach((c) => { if (state[c] === 0) paint(c); }); chordCells = null; }
        pressSingle(i);
        setFace("ooh");
      }
    });
    /* 盘外松开的补录：坐标钳到「棋盘正下方一排外」的规范点——
       ① 引擎按越界判 wasted（flop 同款），不能塞回棋盘格（会误判开格）；
       ② 不能用原始负坐标：AVF 坐标是无符号字节，负值回绕成 65xxx 会让
          下载录像的 path 行程爆炸（2026-10-16 实证）。钳制在录制时做，
       保证 evStream 与下载 AVF 字节逐比特一致 */
    function recordEvPx(mouse: number, px: number) {
      if (over) return;
      const { sec, hun } = evNow();
      const cx = Math.min(Math.max(Math.round(px), 0), W * 16 - 16) + 8;
      evStream.push({ mouse, x: cx, y: H * 16 + 8, sec, hun });
    }
    /* mouseup 挂 window（2026-10-16）：按下后拖出棋盘松开也要捕获——否则事件流里
       留下不配对的 lc，引擎状态机卡住（后续 rc 被吞、lr 误判 Double）。
       非棋盘手势（点笑脸/齿轮/滑杆后的松开）由 leftDown/rightDown 门控忽略。 */
    on(window, "mouseup", (e: MouseEvent) => {
      if (!leftDown && !rightDown) return; // 无棋盘手势：笑脸/设置等点击不进场
      if (over || gameBusy()) { clearPress(); leftDown = rightDown = chordDone = false; return; }
      /* 连击模式松开＝纯复位（2026-10-19）：每次点击的 lc+lr / rc+rr 配对在按下/
         滑过触发时已完整闭合，松开不再补录任何事件——否则引擎里多出无主 lr/rr。
         唯一例外＝松开拔旗（2026-10-19 张老师定）：右键在旗格上松开＝取消标记，
         仅空手松开放行（本次按下没开过格/插过旗/chord 过，comboHit 守卫）——
         按下插旗后同格松开不复位自己的旗、滑动收尾压到旗上也不误拔。
         直接归零不走 toggleFlag（不受问号三态影响：松开即彻底取消标记）；
         事件流补 rc+rr 配对（与常规右键同一口径，回放可见拔旗） */
      if (combo) {
        const ui = rightDown ? eventCell(e) : -1;
        if (ui >= 0 && !comboHit && !nf && state[ui] === 2) {
          recordEv(9, ui);
          state[ui] = 0;
          paint(ui);
          led(ledMines, flagsLeft());
          recordEv(17, ui);
        }
        clearPress(); setFace("smile"); leftDown = rightDown = chordDone = false; return;
      }
      const i = eventCell(e); clearPress(); setFace("smile");
      /* 盘外松开的原始像素坐标（1x 棋盘坐标系，可为负） */
      const gbR = i < 0 ? gboard.getBoundingClientRect() : null;
      const rawPx = gbR ? (e.clientX - gbR.left) / (zoomCur * pageZoom()) : 0;
      const rel = (mouse: number) => { if (i >= 0) recordEv(mouse, i); else recordEvPx(mouse, rawPx); };
      if (e.button === 0) {
        if (rightDown) {
          /* 双击：flop 口径在**松开**生效（松开位坐标），lr 在 rp 下引擎计 Double。
             右键按住期间每次左键松开都触发（连点连 chord，与回放引擎逐次判 Double
             同口径，2026-10-18 张老师定） */
          chordDone = true;
          rel(5); if (i >= 0) chord(i);
        } else if (chordDone) {
          rel(5); // chord 后另一键的松开：只补录闭合配对，不再触发动作
        } else if (i >= 0 && state[i] === 1) {
          /* 单击已开数字格＝双击（练习页独有玩法）：录 sc+lr，统计计 Double（2026-10-16 张老师定） */
          recordEv(11, i); recordEv(5, i);
          chord(i);
        } else {
          rel(5);
          if (i >= 0) openCell(i); // 盘外松开＝取消（引擎按越界计 wasted，flop 同款）
        }
        leftDown = false;
      } else if (e.button === 2) {
        if (leftDown) {
          /* 右键松开的 chord：rr 在 lp 下＝双击（flop 口径）；左键按住期间
             连点右键同理逐次触发（与 lr/rp 对称，2026-10-18 张老师定） */
          chordDone = true;
          rel(17); if (i >= 0) chord(i);
        } else {
          rel(17); // rr：与按下时的 rc 配对闭合（AVF 口径）
        }
        rightDown = false;
      }
      if (!leftDown && !rightDown) chordDone = false;
    });
    on(gboard, "mouseleave", () => { clearPress(); if (!over) setFace("smile"); });
    /* mv 事件流（回放光标 + 引擎行程 pathPx 的数据源）：屏幕坐标 → 棋盘 1x 像素
       （除以倍率与页级缩放，再减棋盘原点）；节流 ≥4px 在 recordMv 内控 */
    on(gboard, "mousemove", (e: MouseEvent) => {
      if (started && !over) {
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
    let touchMoved = false; // 连击滑动连开标记：本次触点发生过轨迹滑动（touchend 据此跳过点按分支）
    let touchX = 0, touchY = 0; // 起点坐标：滑动容差判定用
    let touchLastX = 0, touchLastY = 0; // 连击滑动连开：上一采样点（棋盘 1x 像素坐标）
    /* 触点屏幕坐标 → 棋盘 1x 像素：touch 事件 target 恒为起始格（不跟手指走），
       滑动中必须按坐标算格（与 mousemove/recordMv 同一换算） */
    function touchBoardPx(cx: number, cy: number) {
      const gbR = gboard.getBoundingClientRect();
      return {
        x: (cx - gbR.left) / (zoomCur * pageZoom()),
        y: (cy - gbR.top) / (zoomCur * pageZoom()),
      };
    }
    /* 连击触屏单格动作（2026-10-19，承 nfTouchOpen 改名；与桌面同口径）：
       未开格开（录 lc+lr 对）、已开数字双击（录 sc+lr+chord） */
    function comboTouchOpen(i: number) {
      if (over) return;
      if (state[i] === 1) { recordEv(11, i); recordEv(5, i); chord(i); }
      else if (state[i] === 0) { recordEv(3, i); recordEv(5, i); openCell(i); }
    }
    on(gboard, "touchend", (e: TouchEvent) => {
      if (touchTimer) clearTimeout(touchTimer);
      if (longFired) {
        /* 长按插旗的 rr 闭合（rc 在长按触发时已录） */
        if (touchCell >= 0 && !over) recordEv(17, touchCell);
      } else if (touchMoved) {
        /* 连击滑动连开：动作已在 touchmove 沿轨迹触发完毕，抬起只复位——
           不能再走点按分支（末格已开，会误录 sc+lr 空转双击） */
      } else if (touchCell >= 0 && !over) {
        if (state[touchCell] === 1) {
          /* 单击已开数字格＝双击：录 sc+lr，统计计 Double（与桌面端同口径） */
          recordEv(11, touchCell); recordEv(5, touchCell);
          chord(touchCell);
        } else {
          recordEv(3, touchCell); recordEv(5, touchCell);
          openCell(touchCell);
        }
      }
      touchCell = -1;
      touchMoved = false;
      e.preventDefault();
    }, { passive: false });
    /* 滑动取消带 12px 容差：手指微颤（1-2px）不再吞掉点按——「有时点击无效」
       的主因就是原实现 touchmove 一动即取消（2026-10-14 张老师报） */
    on(gboard, "touchmove", (e: TouchEvent) => {
      if (touchCell < 0) return;
      const t = e.changedTouches[0];
      if (!t) return;
      if (combo) {
        /* 连击滑动连开（2026-10-19 张老师定，承 NF 滑动连开）：容差内不算滑动
           （保长按插旗）；超容差沿手指轨迹按半格步长插值逐格开——touchmove 是
           合并事件，快滑会跳格，插值保证路径上的格不被漏掉。触点下的起始格
           combo touchstart 不再即开（要让位给长按插旗），滑动一开始在此补开
           （state 守卫幂等）；「一格限一次」由 state 变更天然保证 */
        if (Math.hypot(t.clientX - touchX, t.clientY - touchY) <= 12) return;
        if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
        if (over) { touchCell = -1; return; }
        touchMoved = true;
        if (state[touchCell] === 0) comboTouchOpen(touchCell);
        const bp = touchBoardPx(t.clientX, t.clientY);
        const steps = Math.max(1, Math.ceil(Math.hypot(bp.x - touchLastX, bp.y - touchLastY) / 8));
        for (let s = 1; s <= steps; s++) {
          const px = touchLastX + ((bp.x - touchLastX) * s) / steps;
          const py = touchLastY + ((bp.y - touchLastY) * s) / steps;
          const cx = (px / 16) | 0, cy = (py / 16) | 0;
          if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
          const i = cy * W + cx;
          if (state[i] === 0 && i !== touchCell) { touchCell = i; comboTouchOpen(i); }
        }
        touchLastX = bp.x; touchLastY = bp.y;
        return;
      }
      if (Math.hypot(t.clientX - touchX, t.clientY - touchY) > 12) {
        if (touchTimer) clearTimeout(touchTimer);
        touchCell = -1;
      }
    }, { passive: true });
    on(gboard, "touchstart", (e: TouchEvent) => {
      const t = e.changedTouches[0]; if (!t) return;
      const i = eventCell(t); if (i < 0 || over) return;
      touchCell = i; longFired = false; touchMoved = false;
      touchX = t.clientX; touchY = t.clientY;
      const bp0 = touchBoardPx(t.clientX, t.clientY);
      touchLastX = bp0.x; touchLastY = bp0.y;
      /* 连击模式触点不即开（2026-10-19 张老师定）：点按在 touchend 开、滑动在
         touchmove 连开，按下即开要让位给**长按插旗**（连击不禁旗，触屏唯一的
         插旗途径必须保留）；三种手势按位移/时长自然分流 */
      touchTimer = window.setTimeout(() => {
        longFired = true;
        if (nf) { shakeModeBtn(btnNf); return; } // NF 模式：长按插旗禁用（右键语义整体禁用）
        if (state[i] === 1) return; // 已开格长按无意义
        recordEv(9, i); // rc 按下即录（flop 插旗按下生效口径）；rr 在 touchend 补录
        toggleFlag(i);
        /* 速旗模式开时：插旗成功（态→2）后对周围已开数字格预检 chord，
           空 chord 不录不计（2026-10-16 张老师定；此前移动端无条件自动 chord，
           未满足的数字格也计入 Double——移动端 Corr 被系统性拉低的根因） */
        if (autoChord && state[i] === 2) autoChordAround(i);
        if (navigator.vibrate) navigator.vibrate(30);
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
    let zoomWant = 1; // 期望倍率：滑杆/滚轮拖动中的暂存值，松手由 zoomDragEnd→applyZoom 正式定值
    const lsQuery = window.matchMedia("(orientation: landscape) and (max-height: 520px)"); // 横屏拉满断点（声明须在 applyZoom 之前，normalMaxZoom 会读它）
    let zoomBeforeFs: number | null = null; // 进全屏前的倍率；全屏中手动调过则置 null 不再恢复
    /* 普通模式倍率上限：游戏渲染宽不得超过容器宽，否则冲出 #page 版块。
       用 getBoundingClientRect 实测自校准：gfR.width = 基准宽 × zoomCur × 所有祖先
       zoom，gaR.width = 容器宽 × 同一祖先 zoom——比值里 zoom 全部抵消，任意页级
       缩放/窄屏断点下都成立。全屏/横屏由 fitZoom* 拉满（max=5），不走此封顶。
       （v8：#page 版式恒定，标准级别与 cus 统一按当前容器封顶——v7 时代 cus
       「宽度按视口/扩版上限算、不按容器」的前提是页宽跟着盘面走，已废）
       cus 额外加高度封顶：常规三级盘高度有限（≤16 行）从不需要，自定义最高
       99 行会被视口下方内容推出去——按「视口底到游戏区顶的可用高」反算倍率，
       与宽度方向取小，保证整个盘面完整可见不裁切 */
    function normalMaxZoom() {
      if (document.fullscreenElement === root) return 5;
      const gfR = gframe.getBoundingClientRect();
      const gaR = ($("game_area") as HTMLElement).getBoundingClientRect();
      if (gfR.width <= 0 || gaR.width <= 0) return 2.5;
      /* 下限 0.5（=滑杆 min）：窄窗连 1x 都放不下时按容器宽自动缩，保证不溢出。
         自定义大盘（cus）额外放宽到 0.3——99 宽盘在固定 960 版式里即使 1x 也
         远超容器宽，需要更小的自动缩下限才能完整可见 */
      const zMin = lv === "cus" ? 0.3 : 0.5;
      /* 高度封顶（2026-10-15 张老师报：初级拉满切中级，盘冲出屏幕底部）：
         标准级别与 cus 一律不许超出视口底——练习页已整页禁滚动（op-noscroll），
         超出即不可达。⚠️ 必须量整个银框窗 gwrap（计数条+棋盘+状态栏）的高——
         zoom 挂 gwrap，只量 gframe 会漏掉计数条/状态栏（首版量 gframe 实测
         切中级仍溢出 150px 的根因）。hCap = zoomCur×可用高/渲染高，
         rect 比值里当前倍率抵消，与 zoomCur 是否同步无关；
         可用高 = 视口底 − gwrap 顶 − 底部余量 12px（gwrap 顶=容器顶，不随倍率变） */
      const gwR = gwrap.getBoundingClientRect();
      const availH = window.innerHeight - gwR.top - 12;
      const hCap = gwR.height > 0 && availH > 0 ? (zoomCur * availH) / gwR.height : Infinity;
      let cap: number;
      if (lsQuery.matches) {
        /* 横屏沉浸（判定提到最前，2026-10-15 二定「严格占满 100%」）：
           横屏一律按可视视口封顶，**不再区分 cus/标准**——cus 分支的基准是
           window.innerWidth（超宽盘撑爆布局视口时会被放大到 1047 之类），
           会允许盘面宽过真实屏宽 → 被 body overflow:hidden 裁掉。走这里也顺带
           兜底「首帧超宽盘撑爆」：高级盘默认 1.71x = 830px > 屏宽，一旦撑爆
           innerWidth/innerHeight 与 rect 全部失真（2026-10-14 张老师报：高级盘
           横屏高度不对的根因），visualViewport 不受影响。高度由 fitZoomForLandscape
           独立拉满，本分支维持只封宽 */
        const vv = window.visualViewport;
        const vw = (vv ? vv.width : window.innerWidth) / pageZoom();
        cap = (vw - LS_RESERVE_W) / gwrap.offsetWidth;
      } else {
        /* 容器可用宽 = game_area 内容宽 − 16px 余量；基准宽用整个银框窗
           （gwrap，含竖排计数列——zoom 挂 gwrap 后计数列随盘同缩，一起封顶）。
           offsetWidth 不含 zoom（实测），与 zoomCur 是否同步无关 */
        const gaW = gaR.width / pageZoom() - 16;
        cap = Math.min(gaW / gwrap.offsetWidth, hCap);
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
      if (replaying) syncReplayBarWidth?.(); // 回放控制条宽度跟随（二十期）
    }
    function applyZoom(v: number, persist = true, max?: number) {
      zoomWant = v; // 期望倍率暂存（v8 起页宽恒定，仅供 zoomDragEnd 定值用）
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
       上限：面板放大后不得越出视口——超了按空间封顶。低倍率下不放大过游戏倍率
       本身（跟手感），高倍率下按空间封顶防裁切。
       十期修（2026-10-15 张老师截图报「无猜重排行显示不全」）：基准尺寸改为
       **先把自身 zoom 复位 1 再量 rect**——旧法「rect ÷ 当前 zoom」依赖引擎对
       getBoundingClientRect 是否含自身 zoom 的口径一致，WebKit/Safari 下 rect
       不含自身 zoom → rawH 被低估 → cap 偏大 → 面板底部越出视口被裁。
       zoom:1 下量基准尺寸全引擎口径一致；量完即设目标 zoom，中间无绘制。
       十一期（2026-10-15 张老师定「显示比例 >1.5 时，右侧版图尺寸不得超过
       游戏区域的高度」）：高倍率下右侧结算面板不再按视口、改按 **gwrap 渲染高**
       封顶——面板顶本就与 gwrap 顶对齐，压到等高即底边齐平；≤1.5 不启用
       （低倍率面板跟游戏走，压它反而破跟手感） */
    function syncReportZoom() {
      const pz = pageZoom();
      const gwR = gwrap.getBoundingClientRect();
      const gaR = gameAreaEl.getBoundingClientRect();
      if (greport.classList.contains("show")) {
        greport.style.zoom = "1";
        const rect = greport.getBoundingClientRect();
        const rawW = rect.width / pz; // 面板基准尺寸（未缩放布局尺寸）
        const rawH = rect.height / pz;
        if (rawW < 1 || rawH < 1) return;
        const availW = gwR.left - 12 - 14; // 视口左缘 12px + 贴边间隙 14px
        const availH = window.innerHeight - gwR.top - 12;
        /* 右侧结算面板共享同一个 z，cap 还须保证它不越出右缘（2026-10-15 张老师
           截图报：z 曾只按左侧空间封顶，右侧面板按该 z 放大会整块出屏）。
           右侧空间放不下面板自然宽 → 先切窄形态（四按钮 2 列改 4 行单列）再量；
           gresult 可能带着上局残留的 inline zoom，量前先归 1 保口径一致 */
        const availRW = window.innerWidth - gwR.right - 12 - 14;
        gresult.style.zoom = "1";
        gresult.classList.remove("gr_narrow");
        let grect = gresult.getBoundingClientRect();
        let grawW = grect.width / pz;
        if (grawW > 1 && grawW * pz > availRW) {
          gresult.classList.add("gr_narrow");
          grect = gresult.getBoundingClientRect();
          grawW = grect.width / pz;
        }
        const grawH = grect.height / pz; // 窄形态按钮 4 行更高，切完窄再量高
        const rightCap = grawW > 1 ? availRW / (grawW * pz) : 2.5;
        /* 十一期：>1.5 时面板不得高于游戏区（gwrap 渲染高 ÷ 面板基准高 ÷ 页级系数）。
           共享 z 会顺带把左侧数据面板压进同一高度——面板底与游戏窗底齐平，观感一致 */
        const gameCapH = zoomCur > 1.5 && grawH > 1 ? gwR.height / (grawH * pz) : 2.5;
        /* 下限 0.3（2026-10-15 张老师定「面板尺寸自适应，无论如何不出滚动条」）：
           空间极小时允许面板缩得比游戏更小，宁可小也不越界 */
        const cap = Math.max(0.3, Math.min(2.5,
          Math.min(availW / (rawW * pz), availH / (rawH * pz), rightCap, gameCapH)));
        const z = Math.max(0.3, Math.min(zoomCur, cap));
        greport.style.zoom = String(z);
        gresult.style.zoom = String(z);
        /* 定位：面板 zoom 会缩放 left/top 偏移 → 先除回；game_area 局部坐标 =
         (gwrap 渲染坐标 − game_area 渲染坐标) ÷ 页级 zoom（game_area 无 zoom） */
        const toLocal = (v: number) => v / pz / z;
        greport.style.top = toLocal(gwR.top - gaR.top) + "px";
        greport.style.left = toLocal(gwR.left - gaR.left - 14) - rawW + "px";
        gresult.style.top = toLocal(gwR.top - gaR.top) + "px";
        gresult.style.left = toLocal(gwR.right - gaR.left + 14) + "px";
        /* 设后实测闭环（2026-10-15 张老师窗口截图报两面板底被视口截断）：上面的
           cap 是「先量基准÷zoom」的推算，量纲/时序有漏网可能——设完 zoom 实量
           rect，底部仍超视口就按高度比再压一次（高∝z 线性，一步收敛），压完重定位 */
        const grNow = greport.getBoundingClientRect();
        const grTop = grNow.top;
        const grBtm = Math.max(grNow.bottom, gresult.getBoundingClientRect().bottom);
        if (grBtm > window.innerHeight - 8 && grBtm - grTop > 1) {
          const z2 = Math.max(0.3, z * ((window.innerHeight - 8 - grTop) / (grBtm - grTop)));
          greport.style.zoom = String(z2);
          gresult.style.zoom = String(z2);
          const toLocal2 = (v: number) => v / pz / z2;
          greport.style.top = toLocal2(gwR.top - gaR.top) + "px";
          greport.style.left = toLocal2(gwR.left - gaR.left - 14) - rawW + "px";
          gresult.style.top = toLocal2(gwR.top - gaR.top) + "px";
          gresult.style.left = toLocal2(gwR.right - gaR.left + 14) + "px";
        }
      } else if (gresult.classList.contains("show")) {
        /* 📌 数据面板关着时结算面板**独立**定位缩放（2026-10-15 张老师截图报的 bug）：
           此前整个函数被 greport.show 门控——数据面板一关（设置浮窗「显示统计」off），
           gresult 就永远拿不到 left/top/zoom，回退 CSS 兜底 top:0;left:0 + zoom:1，
           面板缩小叠在棋盘左上。同一套几何口径（含十期「zoom 复位 1 再量」修正），
           改量 gresult 自己的 rect、看右侧空间（gwR.right 之外到视口右缘）；
           两端面板同显时仍走上面分支共用 z */
        gresult.style.zoom = "1";
        gresult.classList.remove("gr_narrow");
        let rect = gresult.getBoundingClientRect();
        let rawW = rect.width / pz;
        const availW = window.innerWidth - gwR.right - 12 - 14; // 视口右缘 12px + 间隙 14px
        /* 空间不够先切窄形态（四按钮 2 列改 4 行单列）再量，量完仍超则交给下方 cap 缩 */
        if (rawW > 1 && rawW * pz > availW) {
          gresult.classList.add("gr_narrow");
          rect = gresult.getBoundingClientRect();
          rawW = rect.width / pz;
        }
        const rawH = rect.height / pz;
        if (rawW < 1 || rawH < 1) return; // display:none 中量不出尺寸（换宿主/收起瞬间）
        const availH = window.innerHeight - gwR.top - 12;
        /* 十一期（同上分支）：>1.5 时面板不得高于游戏区，压到与 gwrap 等高（底边齐平） */
        const gameCapH = zoomCur > 1.5 && gwR.height > 1 ? gwR.height / (rawH * pz) : 2.5;
        const cap = Math.max(0.3, Math.min(2.5,
          Math.min(availW / (rawW * pz), availH / (rawH * pz), gameCapH)));
        const z = Math.max(0.3, Math.min(zoomCur, cap));
        gresult.style.zoom = String(z);
        const toLocal = (v: number) => v / pz / z;
        gresult.style.top = toLocal(gwR.top - gaR.top) + "px";
        gresult.style.left = toLocal(gwR.right - gaR.left + 14) + "px";
        /* 设后实测闭环（同上分支）：底部仍超视口就按高度比再压一次 zoom */
        const grNow = gresult.getBoundingClientRect();
        if (grNow.bottom > window.innerHeight - 8 && grNow.height > 1) {
          const z2 = Math.max(0.3,
            z * ((window.innerHeight - 8 - grNow.top) / grNow.height));
          gresult.style.zoom = String(z2);
          const toLocal2 = (v: number) => v / pz / z2;
          gresult.style.top = toLocal2(gwR.top - gaR.top) + "px";
          gresult.style.left = toLocal2(gwR.right - gaR.left + 14) + "px";
        }
      }
    }
    /* 全屏自动拉满——服务移动端 + v8b 扩展（2026-10-16 张老师定：PC 端进全屏保持
       比例不变，只是视口变大、游戏多大还是多大；移动端才需要按屏幕重算比例拉满）。
       **v8b 例外：自定义盘比高级（30×16）还大（宽 >30 或高 >16）时，PC 全屏也自动
       拉满**——大盘小比例进全屏视野浪费，直接按最大可显示比例适配；等于/小于高级
       的自定义盘仍维持「比例不动」。退出全屏由 zoomBeforeFs 恢复原比例（既有机制）。
       移动端口径＝站内既有「移动版」定义：≤768 断点（同 globals.css 移动版规则）
       ＋ 横屏沉浸查询（orientation:landscape 且 max-height:520px，覆盖手机横屏——
       手机横屏宽 844 会超出 768 断点；PC 屏高不满足该查询不会误命中）。
       触屏平板（宽 >768）暂按 PC 处理，张老师反馈了再调。
       拉满量纲（Chrome 实测）：getBoundingClientRect 是渲染尺寸（含 zoomCur 与页级
       zoom pz）；offset* 是布局尺寸但**取整**——棋盘整格是小数（实测 offsetH 208 vs
       真值 208.27），拿它当基准会把倍率算大 1px 高，拉满时正好顶出一条滚动条，故基准
       一律 rect ÷ zoomCur ÷ pz「绝对式」反算（与 zoomCur 是否同步无关），目标尺寸统一
       归一到布局 px（同 fitZoomForLandscape 口径）。max 放到 5：手机上页级 0.65 会把
       渲染尺寸缩回去，拉满常需 3+（不进 localStorage）。

       📌 移动端拉满的竖向预算须按**宿主实际几何**算：此前直接按 `innerHeight − 48`
       （:fullscreen 的 24px 上下 padding）算，把宿主内、游戏窗之外的占位全漏了——
       页头行（标题 + 级别 tabs + 齿轮/全屏按钮，实测 59.5px）压在游戏窗上方，游戏窗底
       会越出视口 36px，宿主 `overflow:auto` 立刻出竖滚动条（1440×900 实测窗底 936.6）。
       现在：竖向 = 宿主内容区底 − 游戏窗顶 − 游戏窗下方流内内容；横向 = #game_area
       内容宽（gwrap 在里面 inline-block 居中，撑过就溢出）。页头占高是「量差值」，
       不随游戏倍率变化，所以每次 fit 都是一次干净重算 */
    const mqNarrow = window.matchMedia("(max-width: 768px)"); // 站内「移动版」断点
    function fsAutoFit() {
      return mqNarrow.matches || lsQuery.matches || (lv === "cus" && (W > 30 || H > 16));
    }
    function fitZoomForFullscreen() {
      if (!fsAutoFit()) {
        /* PC 端：比例原样不动，只把滑杆行程放宽到全屏口径（normalMaxZoom 全屏恒 5，
           玩家在全屏里想手动放大不受普通模式的容器宽限制）。
           ⚠️ 不能走 applyZoom(zoomCur)：cus 大盘 0.3~0.5x 会被 floor 0.5 抬升小幅放大 */
        const capFs = String(normalMaxZoom());
        zoomRange.max = capFs;
        cusZoom.max = capFs;
        return;
      }
      gwrap.style.minHeight = ""; // 撤掉横屏的银框兜底拉伸（横屏中进全屏时残留会撑歪）
      const pz = pageZoom();
      const gwR = gwrap.getBoundingClientRect();
      const baseW = gwR.width / (zoomCur * pz), baseH = gwR.height / (zoomCur * pz);
      if (baseW < 8 || baseH < 8) return;
      /* 宿主＝全屏根容器（#online_play > div）；无全屏（伪全屏/横屏）时退回站点根容器 */
      const host = document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : container;
      const hostR = host.getBoundingClientRect();
      /* 下 padding 的渲染值 = 计算值 × 宿主自身缩放（实测宿主缩放 = pz，移动端 0.65 对齐） */
      const padB = (parseFloat(getComputedStyle(host).paddingBottom) || 0) * pz;
      /* 游戏窗下方的流内内容（当前结构里 #game_area 是宿主最后一个流内子元素＝0；
         留这个扫描是给将来加页脚兜底）——绝不能用 host.scrollHeight：全屏溢出时
         它已被撑大，会把缺口算成 0 */
      let belowH = 0;
      const ga = gwrap.parentElement;
      if (ga && ga.parentElement === host) {
        const kids = Array.from(host.children);
        for (const k of kids.slice(kids.indexOf(ga) + 1)) {
          const kcs = getComputedStyle(k);
          if (kcs.display === "none" || kcs.position === "absolute" || kcs.position === "fixed") continue;
          const r = k.getBoundingClientRect();
          if (r.height <= 0) continue;
          belowH += r.height / pz + (parseFloat(kcs.marginTop) || 0) + (parseFloat(kcs.marginBottom) || 0);
        }
        /* 二十期：回放控制条在 #game_area **内**、gwrap 之后的流内子元素——
           同样计入下方占用（横屏沉浸/移动端全屏不挂条，但全屏中先开回放再进
           全屏的时序会带着条进拉满计算） */
        const gkids = Array.from(ga.children);
        for (const k of gkids.slice(gkids.indexOf(gwrap) + 1)) {
          const kcs = getComputedStyle(k);
          if (kcs.display === "none" || kcs.position === "absolute" || kcs.position === "fixed") continue;
          const r = k.getBoundingClientRect();
          if (r.height <= 0) continue;
          belowH += r.height / pz + (parseFloat(kcs.marginTop) || 0) + (parseFloat(kcs.marginBottom) || 0);
        }
      }
      const availH = (hostR.bottom - padB - gwR.top) / pz - belowH - FS_RESERVE; // 布局 px
      /* 横向：#game_area 无 padding，gwrap 是其中 inline-block（text-align:center）——
         可用宽即其内容宽；窄到放不下时 inline-block 不收缩，靠这条封顶防横向滚动条 */
      const gaCs = ga ? getComputedStyle(ga) : null;
      const availW = ga
        ? ga.clientWidth - (parseFloat(gaCs!.paddingLeft) || 0) - (parseFloat(gaCs!.paddingRight) || 0) - FS_RESERVE
        : hostR.width / pz - 24 - FS_RESERVE;
      if (availH <= 8 || availW <= 8) return;
      applyZoom(Math.min(availW / baseW, availH / baseH), false, 5);
    }
    /* 设置浮窗这张比例滑杆与自定义弹窗那张同源（v7）：共用 zoomDragInput/zoomDragEnd，
       拖动中不重算页宽、松手后一次到位（理由见 zoomDragInput 注释） */
    on(zoomRange, "input", () => zoomDragInput(parseFloat(zoomRange.value)));
    on(zoomRange, "pointerup", zoomDragEnd);
    on(zoomRange, "change", zoomDragEnd);

    /* ---- 滚轮调显示比例（2026-10-15 张老师定）----
       练习页禁滚动，整页锁死由 <html>.op-noscroll 兜住（见 useEffect 开头），
       这里再 preventDefault 一层：overflow:hidden 对滚轮的抑制在各浏览器/宿主上
       并不完全一致（macOS 橡胶带、全屏宿主 overflow:auto 的滚动链仍可能被推动）。
       监听挂 document（整页任意处，含站头/页脚/浮窗）：本页滚轮已无其他用途，
       挂 root 会留下死角——鼠标停在标题行上方空白处滚轮就没反应（playwright
       实证：挂 root 时鼠标在 (0,0) 滚轮完全无效，全屏下才碰巧命中）。
       落盘沿用滑杆口径：滚动中 applyZoom(…, false) 即时生效（按视口封顶），
       停滚 320ms 后 zoomDragEnd 一次正式定值 + 写
       localStorage——免得连续滚动的每一格都写一次盘 */
    let wheelAcc = 0;
    let wheelTimer: number | null = null;
    /* 当前「流内容溢出量」＝html/body/全屏宿主三者的溢出像素，横纵两轴分开量。
       ⚠️ 本页 body 是固定高（=视口）+overflow:hidden，棋盘放大的超高**留在 body 内部**
       被裁剪，不传导到 documentElement（1280×320 实测 de.scrollHeight 恒=320、
       body.scrollHeight 391）——所以 html、body 必须都量，只量 html 永远得 0。
       ⚠️ 横向同样要量（2026-10-15 张老师全屏截图报「右侧结算面板出屏」）：全屏宿主
       overflow:auto（滚动条已隐藏但仍可滚），棋盘放大常「高度装得下、宽度已超宿主」——
       只量纵向则回滚不触发，gwrap 越出屏幕右缘，锚在 gwR.right+14 的结算面板整块出屏。
       ⚠️ 文档基线也可能本来就有溢出，所以不能判「>0」，要判**本次放大是否让溢出
       变大**（见 onWheelZoom 里的差值判定，横纵两轴分别比） */
    function flowOverflowPx() {
      const de = document.documentElement;
      const measure = (el: HTMLElement) => ({
        x: el.scrollWidth - el.clientWidth,
        y: el.scrollHeight - el.clientHeight,
      });
      const ov = measure(de);
      if (document.body) {
        const b = measure(document.body);
        ov.x = Math.max(ov.x, b.x);
        ov.y = Math.max(ov.y, b.y);
      }
      const fsHost = document.fullscreenElement;
      if (fsHost instanceof HTMLElement) {
        const f = measure(fsHost);
        ov.x = Math.max(ov.x, f.x);
        ov.y = Math.max(ov.y, f.y);
      }
      return ov;
    }
    function onWheelZoom(e: WheelEvent) {
      e.preventDefault();
      /* deltaMode 三态归一化到像素：0=像素（Chrome/Safari）、1=行（Firefox 常报行，
         按 16px 行高估）、2=页（罕用，按 100px 估） */
      wheelAcc += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      let steps = Math.trunc(wheelAcc / WHEEL_STEP_PX);
      if (steps === 0) return;
      if (Math.abs(steps) > WHEEL_MAX_STEPS) {
        steps = Math.sign(steps) * WHEEL_MAX_STEPS; // 一步跨太多：封顶并清掉余量
        wheelAcc = 0;
      } else {
        wheelAcc -= steps * WHEEL_STEP_PX;
      }
      const prevZ = zoomCur;
      const baseOv = flowOverflowPx();
      zoomBeforeFs = null; // 手动调过比例 → 退出全屏/横屏不再自动恢复（同滑杆）
      zoomBeforeLs = null;
      applyZoom(zoomCur - steps * WHEEL_STEP_Z, false); // 上滑（deltaY<0）→ 放大
      /* 放大步若让内容超高/超宽（出现滚动条/内容被裁/右侧面板被顶出屏）→ 回滚本步
         放大（2026-10-15 张老师定「无论如何不应该让页面出现滚动条」；同日全屏截图
         报「右侧结算面板出屏」补充：横向溢出同样回滚）。只在放大方向回滚（缩小
         不会产生溢出）；容差 2px 吸收亚像素抖动。回滚后 zoomCur /
         zoomWant 均已由 applyZoom 复原（setZoomVisual 内 syncReportZoom 面板归位），
         320ms 后 zoomDragEnd 落盘的是回滚值 */
      const nowOv = flowOverflowPx();
      if (steps < 0 && (nowOv.y > baseOv.y + 2 || nowOv.x > baseOv.x + 2)) {
        applyZoom(prevZ, false);
      }
      if (wheelTimer !== null) clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => { wheelTimer = null; zoomDragEnd(); }, 320);
    }
    on(document, "wheel", onWheelZoom, { passive: false });

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
    /* 横屏自动拉满是否被手动接管（zoomBeforeLs 管退出恢复、lsManual 管兜底重拉，
       二者分开：首帧就是横屏时 zoomBeforeLs 恒 null，但兜底必须照常生效——
       2026-10-15 张老师 iPhone 实测高级盘横屏没拉满，就是 vh 在 fit 之后
       变了而兜底没接住） */
    let lsManual = false;
    let lsRefitTimer = 0; // 延迟复核拍句柄（防重入堆积）
    function fitZoomForLandscape(once?: boolean) {
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
      /* 目标 = 视口 − 固定 2px 亚像素余量（2026-10-15 三定去外框后：box 镶边/
         银框/棋盘镶边全无，游戏区上/左开销恒 0）。不再量 gaR.top + othersH——
         横屏块已改居中布局（横向 justify-content:center、棋盘在窗内垂直居中），
         量 top 会把居中留白当成开销，fit 重跑时越算越小（抖动源） */
      const targetH = vh - 2;
      const targetW = vw - 2;
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
        /* 居中布局下 top/left 会随缩放移动（留白均分），不能用它们做目标基准；
           rect 高宽除 pz 即「布局高×当前 zoom」，比值直接是 zoom 增益 */
        const grow = Math.min(
          (vh - 2) / (gw1.height / pz),
          (vw - 2) / (gw1.width / pz),
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
         量纲：窗显示高 = 布局高 × zoom（zoom 挂 gwrap 自身），故 min-height 取
         「当前布局高 + 缺口 ÷ zoom」，写小数（1 布局 px ≈ 2.5 显示 px，取整会跨过视口底）。
         gwrap 在横屏块里是 border-box（见 globals.css），布局高口径与 offsetHeight 一致。
         ⚠️ 一次性补差、过则回退：min-height 有明显硬地板（实测自然高 154.8 → 一给
         min-height 就直接落到 157.2 布局 px），因为横排计数列三件套（时间/笑脸/雷数）
         的最小高把 flex 行撑住，中间那几 px 根本踩不到。容忍 ≤3px 过冲——溢出的只是
         窗口最底部 3px 的 padding/边框（计数列 space-between，内容都在其上方），
         肉眼不可见；超过就回退，宁留几 px 背景也不裁内容。
         每次 fit 开头先撤旧值，免得下一次把上次的拉伸计入基准 */
      const rFill = gwrap.getBoundingClientRect();
      const deficit = vh - 2 - rFill.bottom / pz; // 距视口底还差多少（显示 px，扣 2px 余量）
      if (deficit > 0.4) {
        const prev = gwrap.style.minHeight;
        const cur = parseFloat(prev) || 0;
        gwrap.style.minHeight = (Math.max(cur, baseH) + deficit / zoomCur).toFixed(2) + "px";
        if (gwrap.getBoundingClientRect().bottom / pz > vh - 2 + 3) gwrap.style.minHeight = prev;
      }
      /* 延迟复核拍（2026-10-15 三修高级盘没拉满）：真机 Safari 旋转/进出横屏时
         工具栏有 ~300-500ms 动画，fit 跑完 vh 还会变（dev 模拟瞬时切换复现不了，
         iPhone 实测高级盘停在偏小 ~4% 的 zoom、上下露页面背景）。这里收尾后
         再拉一次：动画结束、vh 稳定后自动纠偏。幂等（vh 不变则结果不变）；
         once=true（复核拍自调）不再续拍，链条到此终止，不会死循环 */
      if (once) return;
      if (lsRefitTimer) window.clearTimeout(lsRefitTimer);
      lsRefitTimer = window.setTimeout(() => {
        lsRefitTimer = 0;
        if (lsQuery.matches && !lsManual && document.fullscreenElement !== root && !document.hidden)
          fitZoomForLandscape(true);
      }, 500);
    }
    function syncLandscape() {
      syncLsMax(); // 旋转改变横屏状态 → 高级/自定义的计数列显隐/边框形态先落位
      if (lsQuery.matches) {
        lsManual = false; // 重新进入横屏自动模式（上次横屏中的手动调整不跨旋转保留）
        if (zoomBeforeLs === null) zoomBeforeLs = zoomCur;
        window.scrollTo(0, 0); // 顶满高度以页面顶为基准，先回顶再量
        window.setTimeout(fitZoomForLandscape, 60); // 等媒体查询布局生效后测量（fit 内自带 500ms 复核拍）
      } else if (zoomBeforeLs !== null) {
        gwrap.style.minHeight = ""; // 退出横屏撤掉银框兜底拉伸（竖屏窗口不该被撑高）
        applyZoom(zoomBeforeLs, false);
        zoomBeforeLs = null;
      }
    }
    lsQuery.addEventListener("change", syncLandscape, { signal });
    /* iOS Safari 工具栏显隐/旋转动画常常只触发 visualViewport 的 resize、
       不触发 window resize（2026-10-15 高级盘横屏没拉满的兜底之一）：
       vh 稳定后按新视口重拉。手动接管（lsManual）时不覆盖 */
    window.visualViewport?.addEventListener("resize", () => {
      if (lsQuery.matches && !lsManual && document.fullscreenElement !== root) fitZoomForLandscape();
    }, { signal });

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
        combo: () => combo,
        nf: () => nf,
        ng: () => ng,
        bv3: () => board3bv,
        bvSel: () => ({ ...bvSel[lv] }),
        lv: () => lv,
        ngRedeals: () => ngRedeals,
        /* 统计一致性验证（2026-10-16）：当局事件流 + 共享引擎重算结果 */
        events: () => evStream.slice(),
        counts: () => gameCounts(),
        size: () => ({ w: W, h: H, m: M }),
        /* 诊断：单次重排的 bv（测分布用，不动盘面之外的任何状态） */
        ngOnce: (i: number, opening: boolean) => {
          const ok = noGuessOnce(i, opening, W * H);
          return ok ? board3bv : -1;
        },
      };
    }

    /* 设置浮窗控件初始状态（从 localStorage 恢复的开关勾选态 + 3BV 滑杆初值） */
    swQm.checked = qmark;
    swStats.checked = showStats;
    swTips.checked = tipsOn;
    syncModeButtons(); // 模式快捷钮按存档初值点亮（连击/无猜/速旗）
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
      document.documentElement.classList.remove("op-noscroll"); // 整页锁滚随本页一起摘掉
      if (timerId) clearInterval(timerId);
      if (touchTimer) clearTimeout(touchTimer);
      if (cusTimer !== null) clearTimeout(cusTimer); // 拖杆节流残留的 trailing 定时器
      if (wheelTimer !== null) clearTimeout(wheelTimer); // 滚轮落盘的 trailing 定时器
      /* 开局 tips 的渐隐定时（卸载时不留残余回调） */
      if (tipFadeTimer !== null) clearTimeout(tipFadeTimer);
      if (win.__op) delete win.__op;
    };
  }, []);

  return (
    /* op_root：根容器相对定位锚——底部气泡 tips 按它定位（横屏块里的
       #online_play > div 已有 position:relative，此处补上竖屏/桌面态）。
       ⚠️ op-lsmax 等运行时类由 JS classList 追加，与静态类互不干扰 */
    <div ref={rootRef} className="op_root">
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
        {/* 右上角图标按钮排（2026-10-14 二期张老师定，九期追补模式快捷钮）：
            NF／速旗／连击／无猜四颗模式钮在齿轮左侧——激活显色（NF=默认黄 /
            速旗=默认黄 / 连击=绿（2026-10-19 二次定）/ 无猜=绿），未激活灰；
            NF／无猜点击重开一局，速旗/连击只改行为不重开（原「自动双击」开关口径） */
        }
        <div className="gicons">
          {/* 模式快捷钮 hover 出气泡（2026-10-15 九期张老师定）：文案与设置浮窗
              对应开关的 .tip 一致；不用原生 title（会跟气泡双份弹） */}
          {/* NF 模式（2026-10-19 张老师定：恢复保留，语义收窄为仅禁右键）：
              文本钮沿用旧样式；激活显色＝默认黄（.gicon.active 站内黄） */}
          <button className="gicon gmode" id="btn_nf" type="button">
            NF
            <span className="tip">NF 模式：不能插旗，右键已禁用</span>
          </button>
          {/* 速旗模式（2026-10-16 张老师定）：小旗图标＋NF 右侧；激活沿用 .gicon.active
              默认黄。行为＝原「自动双击」开关（插旗后自动 chord）＋右键点已开数字也视为
              双击（左键单击数字本就全局生效）；与 NF 互斥 */}
          <button className="gicon gmode" id="btn_sq" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {/* 旗杆 + 右侧内凹三角旗面（线稿风格与齿轮/全屏一致） */}
              <path d="M6 21V3.5" />
              <path d="M6 4.5h11.5l-3 4 3 4H6z" />
            </svg>
            <span className="tip">速旗模式：开启后右键标雷自动尝试双击周围格子，左右键点击数字都视为双击</span>
          </button>
          {/* 连击模式（2026-10-19 张老师定）：鼠标双击图标（指针＋尖端两道点击弧线）；
              按下即触发、按住滑动连续点击（左开右旗，一格限一次）；与速旗不互斥；
              移动端首次进入自动开启；位置在无猜之前；激活显色＝绿（gmode_combo，
              与无猜同色，2026-10-19 二次定）。图标三改（19 日三次定）：参考
              「食指点击」样式重绘——竖起食指＋两个指节圆弧＋拳底，指尖上方两道
              同心点击弧线 */}
          <button className="gicon gmode gmode_combo" id="btn_combo" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {/* 指尖两道同心点击弧线（圆心=指尖，半圆弧） */}
              <path d="M5.25 8.2a6.4 6.4 0 0 1 12.8 0" />
              <path d="M7.75 8.2a3.9 3.9 0 0 1 7.8 0" />
              {/* 手：食指竖起（圆帽指尖）→ 两个指节圆弧 → 拳身 → 圆底收回到指根 */}
              <path d="M9.9 14.2V7.3a1.75 1.75 0 0 1 3.5 0V10.5a1.55 1.55 0 0 1 3.1 .55a1.55 1.55 0 0 1 3.1 .55V16.6a6.3 6.3 0 0 1 -9.7 3.1V14.2Z" />
            </svg>
            <span className="tip">连击模式：按下鼠标即触发，对滑过的格子自动进行点击</span>
          </button>
          <button className="gicon gmode gmode_ng" id="btn_ng" type="button">
            {/* 雨伞图标（2026-10-15 九期五改，张老师定）：合伞＝未激活态、
                张伞＝激活态，两颗 SVG 叠放、CSS 按 .active 切换显示（无 JS 参与）；
                fill=none stroke=currentColor 随激活态变色，与齿轮/全屏线稿风格一致 */}
            <svg className="ic_closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {/* 合着的伞：收拢伞面 + 束带 + 弯柄 */}
              <path d="M12 1.9 V2.8 C10.3 4.6 9.6 7.4 9.6 10.6 C9.6 13.4 10.3 15.6 12 17.2 C13.7 15.6 14.4 13.4 14.4 10.6 C14.4 7.4 13.7 4.6 12 2.8 Z" />
              <path d="M9.8 12.8 C10.5 13.3 13.5 13.3 14.2 12.8" />
              <path d="M12 17.2 V19 C12 20.2 10.4 20.5 9.8 19.7" />
            </svg>
            <svg className="ic_open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {/* 张开的伞：波浪下缘伞面 + 中肋 + 直柄弯钩 */}
              <path d="M12 2.6 C7.2 2.6 3.4 6.2 3.4 10.9 C5.5 9.9 9.9 9.9 12 10.9 C14.1 9.9 18.5 9.9 20.6 10.9 C20.6 6.2 16.8 2.6 12 2.6 Z" />
              <path d="M12 2.6 V10.9" />
              <path d="M12 10.9 V18.4 C12 19.9 10.3 20.2 9.7 19.3" />
            </svg>
            <span className="tip">无猜模式：踩雷时在不改变已开数字的前提下尝试重排局面</span>
          </button>
          <button className="gicon" id="btn_settings" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
            </svg>
            <span className="tip">设置</span>
          </button>
          <button className="gicon" id="btn_fs" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
            {/* 常驻 hover 气泡（2026-10-16 v8d 张老师定）：形态与模式快捷钮同款；
                不用原生 title（会跟气泡双份弹），全屏中/退出后文案不变 */}
            <span className="tip">全屏沉浸式体验</span>
          </button>
        </div>

        {/* 设置浮窗：齿轮点开（无头部栏/关闭按钮——外点、Esc、再点齿轮均可关）；
            含 问号/数据统计 开关、显示比例滑杆、3BV 范围双端点滑杆。
            （NF/无猜两项已于十期撤出设置——入口收敛到两颗模式快捷钮；「显示3BV」
            开关已随状态栏一并取消，八期。）
            全部状态入 localStorage（online_play_settings），比例仍走原 online_play_zoom 键 */}
        <div className="gsettings" id="gsettings">
          {/* 开关名 ≤4 字（2026-10-14 张老师定），完整解释放 hover 气泡（.tip） */}
          <div className="gs_row">
            <span className="gs_name">问号标记</span>
            <label className="gsw"><input type="checkbox" id="sw_qm" /><span className="track" /></label>
            <span className="tip">右键按 标雷 → 问号 → 取消 三态循环</span>
          </div>
          {/* 「数据统计」（原「显示统计」，2026-10-15 十期张老师定改名；2026-10-16 张老师定
              默认开）：左侧数据统计面板的唯一入口。八期口径：只在游戏结束时出现（对局中
              不再常驻实时刷新） */}
          <div className="gs_row">
            <span className="gs_name">数据统计</span>
            <label className="gsw"><input type="checkbox" id="sw_stats" /><span className="track" /></label>
            <span className="tip">游戏结束后在游戏界面左侧弹出数据统计面板</span>
          </div>
          {/* 「开局提示」（2026-10-19 张老师定，默认开）：每次开局显示一条技巧气泡——
              当天不重复、全部出现后不再提示（次日重新轮起）；关闭后任何开局提示都不出 */}
          <div className="gs_row">
            <span className="gs_name">开局提示</span>
            <label className="gsw"><input type="checkbox" id="sw_tips" /><span className="track" /></label>
            <span className="tip">每次开局显示一条技巧提示，当天不重复，可随时关闭</span>
          </div>
          {/* 「自动双击」设置行已撤（2026-10-16 张老师定）：入口改挂 NF 右侧的
              速旗快捷钮（btn_sq），行为口径不变 */}
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

      {/* 开局气泡 tips（2026-10-15 张老师定；2026-10-19 改「每局一条」）：主体板块下方
          （隔一条缝隙），正文前一枚金色灯泡，3 秒后渐隐（元素常驻复用，见上文 tips 块）。
          挂组件根（#game_area 之外）→ 不吃游戏倍率，也不参与任何 fit 量测
          （绝对定位脱流，出现/消失都不会让版面跳动） */}
      {/* ⚠️ .txt 在 SSR 阶段恒为空（文案由 useEffect 随机填，见上文 tips 块）——
          随机值若进渲染期会 hydration mismatch，故结构先渲染、文字后填 */}
      <div className="optips" id="op_tips" role="note">
        {/* 金色灯泡（Monokai 黄 #E6DB74，与录像雷达数值金同色）；灯口两道螺纹略深 */}
        <svg className="bulb" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#E6DB74"
            d="M12 2.6C8.2 2.6 5.2 5.6 5.2 9.4c0 2.7 1.7 4.5 2.6 5.7.4.6.7 1.1.9 1.7h6.6c.2-.6.5-1.1.9-1.7.9-1.2 2.6-3 2.6-5.7 0-3.8-3-6.8-6.8-6.8z" />
          <rect x="9.4" y="17.2" width="5.2" height="1.5" rx="0.75" fill="#C9BD5E" />
          <rect x="10.1" y="19.2" width="3.8" height="1.4" rx="0.7" fill="#C9BD5E" />
        </svg>
        <span className="txt" />
      </div>
    </div>
  );
}
