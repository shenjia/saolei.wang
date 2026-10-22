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
import { flushSync } from "react-dom";
import { FlopSprites } from "./FlopSprites";
import { VideoAnalysisRadar } from "./VideoAnalysis";
import { toast } from "./Toast";
import { buildOnlineAvf, onlineAvfFilename, type OnlineEvent } from "@/lib/avfwrite";
import { replayCounts, MOUSE_CODE_TO_EV, type ReplayCounts } from "@/lib/replay-core";
/* 拖拽导入录像（2026-10-21）：站内同款解析管线全为纯前端（avf/mvf 择优/rmv →
   rawvf 结构化 → videowin 胜负判定），录像详情页 VideoReplay 同套客户端在用 */
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvfBest } from "@/lib/mvf-best";
import { rmvToRawvf } from "@/lib/rmv";
import { formatRawvf } from "@/lib/rawvf";
import { judgeVideoOutcome } from "@/lib/videowin";
import { LEVEL_NAMES } from "@/lib/config";
import { paintRangeFill } from "@/lib/paintRange";
import { bumpLocalPractice } from "@/lib/practice-local";
import type { VideoAnalysisPoint } from "@/lib/videoscore";
import {
  DIST_BUCKET_ALL,
  demoteGrade,
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
/* 全屏模式显示比例上限（2026-10-21 张老师定）：高级盘 PC 全屏无上限可拉到 5x，
   格子像素级失真、超屏分辨率渲染白耗性能——封 2.4。普通模式上限 2.5 不动，
   仅全屏相关路径（normalMaxZoom 全屏分支 / fitZoomForFullscreen 拉满 / 滑杆行程）受限 */
const FS_ZOOM_CAP = 2.4;
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
   每次开局（reset）从池里随机取一条，在主板块底部以气泡浮现
   （正文前一枚金色灯泡），3 秒后渐隐；不做已显记录、每局必出可重复
   （2026-10-19 二改，张老师定「去掉不能重的逻辑」）。
   设置浮窗「开局提示」开关（默认开）可整体关闭，关闭后任何提示都不出。
   ⚠️ 文案一律只写**已上线**的既有行为（口径与设置浮窗 .tip / 各按钮 title 一致），
      别把计划中或已废弃的功能（如「显示3BV」「极简模式」）写进来；
      技法类条目提炼自 /page/guide 教程（来源见池内注释，勿与功能口径混淆） */
const TIPS: string[] = [
  "手机上把屏幕横过来，棋盘会自动拉满整屏，视野更开阔。",
  "点右上角全屏按钮进入沉浸模式，页面其他内容全部让位。",
  "无猜模式下需要靠猜的局面会自动重排，全程都能靠推理解决。",
  "鼠标滚轮可直接调显示比例：上滑放大，下滑缩小。",
  "设置里能限定 3BV 范围，只练你想要的开局难度。",
  "在线练习录像不能参与排行，下载后仅供自己回看。",
  "手机上长按格子可以标雷，标完会自动展开周围已满足的数字格。",
  "点笑脸随时重开一局（自定义手摆的图会一直保留，切模式或重新摆雷才换）；F2 恒换新地图。",
  "禁旗模式（NF）下不能插旗，按下即开，滑动可以开多格。",
  "连击模式下按下鼠标即触发，按住左/右键滑动可连续点击滑过的格子（一格一次）。",
  "左右键同按（或单击已满足的数字格）可一次展开一圈，比逐格点快。",
  "自定义盘可以自由设定宽、高、雷数（8 – 99），想练什么规格都行。",
  "每局结束会给出 STNB 与五维雷达评级，口径与录像详情页一致。",
  "踩雷后可以按空格原地复活：撤销那一步误点，计时继续。",
  /* ---- 2026-10-19 张老师定：补录未收录的新功能与快捷键 ---- */
  "键盘 1/2/3 快速切换初级/中级/高级（同级再按＝刷新重开），4 打开自定义盘。",
  "快捷键：A 随时再来一局，结算后 R 重玩同一盘面、V 查看回放、D 下载录像。",
  "查看回放就在本页原地重演整局操作，按 Esc 或点笑脸即可退出。",
  "速旗模式：右键标雷后自动双击周围数字格，点数字格也视为双击。",
  /* ---- 2026-10-19 张老师指定两条 ---- */
  "已经完全确定的雷，如果不能帮助开空，就不要标出来。",
  "冬天手冷会影响发挥，可以先暖暖手再玩。",
  /* ---- 2026-10-19 张老师定：从 /page/guide 教程文章提炼的单句提示 ----
     （定式/猜雷 ← 张砷镓《雷诀八条》《猜雷的一些心得》《扫雷定式及变化》；
      标雷原则 ← 张砷镓《谈局部最优化操作》、李峰《怎样节省标雷》；
      路线/NF ← 郭蔚嘉《郭嘉NF经验谈》；隔空判雷 ← 周丹《浅谈隔空判雷及标雷》；
      硬件/状态 ← 《扫雷基本经验》《关于调节鼠标速度》《怎样调节适合自己的鼠标灵敏度》
      《扫雷游戏前热身之我见》） */
  "基本定式（11、21、121、212）要练到条件反射，只靠现场推理速度不够。",
  "121 定式：2 夹在两个 1 中间时，2 正对的格子不是雷，两侧都是雷。",
  "死猜（边部 2 选 1 等）遇到就立刻猜，犹豫最浪费时间。",
  "边部 2 选 1 时，靠边的方块不是雷的几率更大。",
  "条形 3 选 1 标中间的雷，3 选 2 点中间的空。",
  "全封闭的猜雷可以留到最后：其余格子都扫通后它自然得解。",
  "永远用固定的方法猜雷，换来换去只会连猜连错。",
  "标雷的原则：标 n 颗雷至少要能多开 n+1 格（标一开二），否则不如直接点开。",
  "角部或长排的雷已经明确时可以不标：旁边只剩一个空格就直接左键点掉。",
  "优先点离鼠标最近的安全格：减少移动距离比减少点击次数更省时间。",
  "有意识地练习从右往左、从下往上的反向判雷，别只会一个方向。",
  "NF 入门：先对 1 和 2 做到条件反射，3 及以上再靠数雷。",
  "猜错了不要懊悔，按 F2 重开又是一局，心态也是实力。",
  "隔空判雷：已标一雷的 2 等同于 1，复杂局部往往是定式的变种。",
  "鼠标速度调慢一点、关掉系统的「提高指针精确度」，定位会稳很多。",
  "调鼠标灵敏度的参考标准：一次自然的手部移动恰好移过一格的宽度。",
  "戴上耳机听音乐并让音量压过鼠标按键声，点击速度更容易放开。",
  "玩一会儿需要精确移动鼠标的小游戏热热身，再开始扫雷状态更好。",
  /* ---- 2026-10-19 新手提示功能上线补录 ---- */
  "卡住时打开设置里的「新手提示」，会标出附近能确定的雷和安全格。",
  /* ---- 2026-10-21 拖拽导入录像上线补录（张老师定文案） ---- */
  "将录像文件拖到练习界面里可以播放录像。"
];
/* tips 生命周期（ms）：fade-in 由挂载后下一帧加 .show 触发；
   TIP_HOLD_MS 后撤 .show 走 transition 渐隐（元素常驻复用、无卸载时序）。
   （旧 TIP_FADE_MS 已随 .optoast 废弃删除——2026-10-21 局中通知改走全站 Toast） */
const TIP_HOLD_MS = 3000;

/* 键盘类 tips 条目特征（2026-10-21 张老师定：移动端没有键盘，不出现快捷键提示）——
   命中即从触屏设备的候选池剔除。须同时覆盖两种在途文案形态（改写版「按1234数字键」
   「踩雷后按A键/按R键」与原版「键盘 1/2/3 快速切换」「快捷键：A 随时再来一局」），
   以及 F2 / Esc / 空格（按空格复活也是键盘教学；复活按钮触屏可点，评级警告桌面保留）。
   ⚠️ 精心选词防误伤：「长按格子」「按下即开」「按住左/右键」「左右键同按」「鼠标按键声」
   都不含下列模式；改 TIPS 池文案时须对照维护本正则 */
const KEY_TIP_RE = /键盘|快捷键|按 ?F2|数字键|按 ?A ?键|按 ?R ?键|按 ?Esc|按 ?空格/;

/* ---- 新手提示（2026-10-19 张老师定，设置开关默认关；二版同日改）----
   对局中连续 ROOKIE_IDLE_MS 无有效操作（标雷 = 插上旗、开空 = 开出格子）时
   激活：全图（四版 2026-10-20 张老师定：不再限定鼠标半径）标示——
   可 100% 推理确定的雷格叠半透明雷图标、确定非雷的未开格静态绿框标示
   （二版：安全格不再闪烁，透明度 0.45）；下一次有效操作重新计时。
   设置开关 id=sw_rookie，hover 文案＝张老师原话「当卡住时，提示附近能确定的地雷和空」 */
const ROOKIE_IDLE_MS = 3000;

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
    /* 触屏设备判定（2026-10-21 张老师定）：移动端没有键盘，快捷键类提示一律
       不出现——tips 池剔除键盘条目、结算按钮键帽（kbd）不渲染。
       口径与连击模式自动开启一致（pointer:coarse），iPad 外接键盘属罕见个案可接受 */
    const touchUI = window.matchMedia("(pointer: coarse)").matches;
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
       tips：每次开局（reset 末尾调 showTip）随机显示一条（TIPS 池，
       2026-10-19 二改：张老师定「去掉不能重的逻辑」——不做已显记录，
       每局必出、纯随机可重复）；设置浮窗「开局提示」开关关闭则任何提示都不出。
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
    /* 开局提示候选池（2026-10-20）：「允许复活」关着时剔除空格复活两条
       （教玩家按空格却无效是误导；「踩雷后按A/R」那条不含复活、保留）。
       触屏设备（2026-10-21 张老师定「移动端不要再出现快捷键提示，没有键盘」）：
       KEY_TIP_RE 剔除全部键盘类条目（F2/数字键/A/R/Esc/空格/「键盘」「快捷键」字样） */
    function tipPool(): string[] {
      let pool = reviveOn ? TIPS : TIPS.filter((s) => !s.includes("复活"));
      if (touchUI) pool = pool.filter((s) => !KEY_TIP_RE.test(s));
      return pool;
    }
    function showTip() {
      if (!tipsOn) return;
      const pool = tipPool();
      const idx = Math.floor(Math.random() * pool.length);
      tipsEl.querySelector(".txt")!.textContent = pool[idx];
      if (tipFadeTimer !== null) clearTimeout(tipFadeTimer);
      /* 下一帧再挂 .show：确保从 opacity:0 初始态起步，同帧加类会被合并、
         transition 不触发（气泡就「闪」一下没了） */
      requestAnimationFrame(() => tipsEl.classList.add("show"));
      tipFadeTimer = window.setTimeout(() => tipsEl.classList.remove("show"), TIP_HOLD_MS);
    }
    /* 局中通知（下载成功 / 导入失败 / 复活）走**全站居中气泡**（2026-10-21 张老师定：
       与其他全站居中提示同组件同尺寸——components/Toast.tsx，fixed 视口居中、success
       带 ✓；此前自造的 .optoast 底部小气泡已废）。ToastHost 挂在 layout 全站生效，
       这里只需命令式调用 */
    function showToast(msg: string, err = false) {
      toast(msg, err ? "error" : "success");
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
       （showTip，见上方 tips 块，随机可重复）；
       关闭后任何开局提示都不出（下载成功等局中通知气泡不受它管） */
    let tipsOn = true;
    /* 「新手提示」开关（2026-10-19 张老师定，默认关）：对局中连续 3 秒无有效操作
       （标雷 = 插上旗、开空 = 开出格子）时，鼠标 10 格半径内 100% 可确定的雷
       叠半透明雷图标、可确定的非雷格 500ms 闪烁；下一次有效操作立即停止 */
    let rookieOn = false;
    /* 「允许复活」开关（2026-10-20 张老师定，默认开）：关闭后原地复活功能整体
       下线——踩雷结算面板不再出现「原地复活」按钮、空格键不触发（revive() 入口
       同步拦截）、开局提示里复活相关条目也一并不出（教玩家按空格却无效会误导）。
       切换即时生效（含已定格的败局结算面板）、不重开当前局、不影响快照拍摄
       （中途重新打开可立即使用） */
    let reviveOn = true;
    /* ---- 新手提示运行时状态（全部在本 effect 闭包内，不触 React）----
       anchor: -1 = 未激活；1 = 激活中（四版全图模式无锚点坐标语义）
       shown: 激活时定格的提示集合（mines/safe/low）；期间新开格由
         rookieAction 摘除、不重算（四版「提示期间新开格不显示提示」）
       lastAct: 上次有效操作时刻（performance.now()）——计时起点
       timer: 唤醒定时器（每 300ms 复查「闲置满 3 秒？」） */
    let rookieAnchor = -1;
    let rookieShown: { mines: number[]; safe: number[]; low: number[] } | null = null;
    let rookieLastAct = 0;
    let rookieTimer: number | null = null;
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
          showStats?: boolean; autoChord?: boolean; tips?: boolean; rookie?: boolean; revive?: boolean;
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
        if (typeof s.rookie === "boolean") rookieOn = s.rookie;
        if (typeof s.revive === "boolean") reviveOn = s.revive;
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
        localStorage.setItem(LS_KEY, JSON.stringify({ nf, combo, ng, qmark, showStats, autoChord, tips: tipsOn, rookie: rookieOn, revive: reviveOn, lv, bv: bvSel, cus: cusSpec }));
      } catch { /* 隐私模式 */ }
    }
    /* 上次级别（loadSettings 恢复；无记忆/脏数据回落 beg） */
    let savedLv = "";
    loadSettings();
    /* NF 与速旗互斥（2026-10-16 张老师定）：互斥上线前的存档可能两个同开，NF 优先 */
    if (nf && autoChord) autoChord = false;
    let mines: Uint8Array | null = null, nums: Uint8Array | null = null;
    /* ---- 手动摆雷模式（2026-10-21 张老师定）：自定义盘专用 ----
       manualMode＝摆雷阶段激活（仅 !started 期间有意义，切出 cus / 首击消费后清）；
       manualBoard＝本局雷区为手摆（首击那一刻定格，无猜重排整体禁用，reset 清） */
    let manualMode = false, manualBoard = false;
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
    /* 连击开局保护（2026-10-19 张老师定首击手势版，2026-10-22 改**开局后即生效**）：
       原口径＝首击手势内滑动不开格（「第一下只能点」）；连击改为开局即生效后，
       保护随之改为**时间窗内跳雷**（张老师同日二定：「一秒内也应该是滑动连开，
       只是把碰到雷的格子跳过」）——首格开出（openCell 起表，startTimer 末尾写
       comboGraceT0）起保护窗内，连击滑动/按下路径上的**安全格照常连开**，仅
       **有雷的格子被跳过**（无事件零动作，玩家无感；无猜首击 3×3 保护只在
       首格，盲滑轨迹仍会踩雷——开局一瞬误滑就暴毙是开局暴毙主因）。窗口到期
       全放行（雷格也照常触发＝回到真实排雷）。时长三定（同日）：**初级不设
       保护、中级/高级/自定义半秒**；四定（同日）：中级收窄 **250ms**，且
       **开局后松开左键（触屏抬起）即刻终止**——保护只活在开局那次按住手势
       内。首格＝首击入口照常开（无猜下 placeMines 保证安全） */
    let comboGraceT0 = 0;
    /* 保护窗时长按级别（2026-10-22 张老师三定/四定）：初级不设保护，中级
       250ms、高级/自定义 500ms；且**开局后用户松开左键（触屏＝抬起手指）
       即刻终止**（四定）——保护只活在开局的那次按住手势内，时长上限只是
       防按住过久的双保险（桌面 mouseup / 触屏 touchend 均置 comboGraceT0=0）。
       开局切级别时 lv 已先落位，首击读到的一定是本局级别 */
    const COMBO_GRACE_MS = () => (lv === "beg" ? 0 : lv === "int" ? 250 : 500);
    /* 保护窗内＝连击开格要跳雷（性能计时，不受复活回拨影响）；未开局恒 false */
    const comboShield = () => started && performance.now() - comboGraceT0 < COMBO_GRACE_MS();

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
    /* ---- 结算浮层（2026-10-15 七期；2026-10-19 二版扩到桌面）-----------------------
       全屏遮罩 + 屏幕居中卡片，点遮罩关闭。**两种情形弹它**：
       ①<960px：CSS 里 .greport.show/.gresult.show 只在 ≥960 生效，窄屏没有侧边位；
       ②≥960px 但空间被挤爆：任一显示中的面板侧边渲染宽 < 120px（张老师截图：全屏
         高级最大比例下两侧面板小到看不清）→ 收起侧板、改遮罩居中显示。
       ⚠️ 必须挂 body 直下（同 #fs_tip）：#page 在 ≤605px 有整页 zoom，做在 #page 里的
          fixed 遮罩会随缩放失真、铺不满屏（本项目的既有教训）；全屏态再搬进全屏宿主
         （浏览器只渲染 fullscreenElement 子树，挂 body 的浮层会整体不可见）。
       断点与 CSS 的 (min-width: 960px) 必须同值——JS 按它决定面板有没有侧边位。 */
    const mqPanelDesktop = window.matchMedia("(min-width: 960px)");
    const grModal = document.createElement("div");
    grModal.id = "gr_modal";
    grModal.hidden = true;
    /* 卡片里两个宿主槽（2026-10-19 二版）：grm_result 放结算面板、grm_stats 放数据面板。
       面板本体仍是 #game_area 里的 #greport / #gresult 两个节点——进出遮罩＝搬家，
       不重建 DOM（雷达 React root、按钮事件绑定都不丢）。DOM 顺序＝结算在前、数据在后：
       竖屏单列时结算在上、数据在下（张老师定）；横屏 row 用 order 把数据摆到左侧。
       卡片本身只做 flex 容器（透明无边框），两块面板各带自己的深色盒子 */
    grModal.innerHTML =
      '<div class="grm_card" id="grm_card">' +
      '<div class="grm_slot" id="grm_result"></div>' +
      '<div class="grm_slot" id="grm_stats"></div>' +
      "</div>";
    document.body.appendChild(grModal);
    const grmCard = grModal.querySelector("#grm_card") as HTMLElement;
    const grmResult = grModal.querySelector("#grm_result") as HTMLElement;
    const grmStats = grModal.querySelector("#grm_stats") as HTMLElement;
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
      /** 拖拽导入局标记（2026-10-21）：回放播完即退、定格引擎终态（败局揭示雷区），
          与「刚打完一局」形态一致；自打局维持原口径（侧边态停在回放终帧） */
      imported?: boolean;
      /** 手摆局标记（2026-10-21）：快照来自手摆图对局——R「重玩本局」复刻后
          仍按手摆局口径（manualBoard=true）禁用无猜救回，防重排改写手摆图 */
      manual?: boolean;
      stats: {
        solvedBv: number; cl: number; ce: number; stnb: number;
        bvs: number; ioe: number; corr: number; cls: number; ppc: number;
      };
    }
    let snapshot: GameSnapshot | null = null;

    /* ---- 原地复活（2026-10-19 张老师定）：踩雷后回滚「上次踩雷的那次点击」，时间继续 ----
       回滚粒度＝**整次点击手势**（不是最后那半个事件）：致命点击可能是 lc→lr 的完整
       松开开格、双键 chord（松开触发展开）、连击/触屏轨迹开格——任何一种，其
       事件序列在「致命动作发生」那一刻才完整闭合。快照采用**手势起点拍摄**：
       每次新手势（mousedown / touchstart）先拍一份「手势前状态」，踩雷升级为
       死亡快照；复活＝回到手势起点（事件流剥到手势前长度，lc/sc/rc 等按下
       事件一并回滚——重放引擎状态机没有半开手势，统计天然自洽）。
       计时器不停表：复活后从死亡时刻续跑（「时间继续」的题意，练习者损失
       思考时间自己承担）。连续复活：每次致命手势都会重新升级快照；revives
       累计到终局（reset 清零）。 */
    interface DieSnapshot {
      state: Uint8Array;
      openedSafe: number;
      mines: Uint8Array;
      nums: Uint8Array;
      bvRegions: number[][];
      bvSingles: number[];
      bvIslands: number[][];
      board3bv: number;
      origMines: Uint8Array | null;
      hit: number;
      evLen: number;   // 事件流剥到这个长度（手势前的完整序列）
      csec: number;    // 手势起点时刻（百分秒）——复活后计时从这里续跑
      minesLed: number;
    }
    let dieSnap: DieSnapshot | null = null;   // 死亡快照（终态＝败局结算才有）
    let gestureSnap: DieSnapshot | null = null; // 手势起点快照（每次新点击手势重拍）
    let revives = 0; // 本局已复活次数（reset 清零；终局随统计口径自然记入快照）
    /* 败局埋点延迟句柄（原地复活 2026-10-19）：败局 beacon 晚 300ms 发送，
       复活即撤销（见 report/revive/reset 三处清理） */
    let pendingLoseBeacon: number | null = null;
    /* 手势起点快照：新点击手势（mousedown / touchstart）入口调用。盘面/统计构件
       全量复制（8×8 初级 ~64 格、16×16 ~256、exp 480——一次 copy 可忽略）。
       两道闸门：
       ① !started（首击前）不拍——雷区尚未生成（重玩锁定盘首击可能即雷，
          但空雷区快照复活会把整盘变成无雷废盘，宁可不提供复活）；
       ② 只在手势**首键**拍（mousedown 传入时 leftDown/rightDown 均为假）——
          双键 chord 的第二键不覆盖快照，回滚才能把整次手势（含孤儿按下事件）
          干净剥掉，重放引擎不留半开手势 */
    function snapGesture(hit: number) {
      if (!started) return;
      if (leftDown || rightDown) return;
      gestureSnap = {
        state: state.slice(), openedSafe,
        mines: mines ? mines.slice() : new Uint8Array(0),
        nums: nums ? nums.slice() : new Uint8Array(0),
        bvRegions: bvRegions.map((r) => r.slice()),
        bvSingles: bvSingles.slice(),
        bvIslands: bvIslands.map((r) => r.slice()),
        board3bv,
        origMines: origMines ? origMines.slice() : null,
        hit,
        evLen: evStream.length,
        csec: started ? Math.floor((performance.now() - startTs) / 10) : 0,
        minesLed: ledMinesCur,
      };
    }


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
      comboGraceT0 = startTs; // 连击开局保护窗起点＝起表时刻（首格开出）
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
      if (!started) {
        started = true;
        if (manualMode && manualPlaced < M) { started = false; return; } // 手摆未摆满：摆雷期双保险（正常路径到不了这）
        if (manualMode) {
          /* 手动摆雷局：雷区＝已绘雷位（manualMines → mines），跳过 placeMines
             （无首击 3×3 保护——雷是玩家自己摆的，首击踩雷属自担）；
             manualBoard 定格＝本局无猜重排整体禁用。摆雷 UI 收尾：
             雷位贴图还原为未开格（state=0，开局后重画） */
          manualBoard = true;
          manualMode = false;
          mines = manualMines.slice();
          manualStoredMines = mines.slice(); // 常驻副本：此后点笑脸一直复玩这张图
          manualMines = new Uint8Array(0);
          stopManualMode();
          recalcAll();
          repaintAll();
        } else placeMines(i);
        startTimer();
      }
      if (mines![i]) {
        /* 必雷格（被已开数字 100% 锁死）：直接判负，绝不重排、盘面与 3BV 零变化
           （2026-10-14 张老师定）。其余踩雷才走无猜救回。重排不弹任何提醒
           （张老师定：笑脸/盘面状态已够） */
        /* 原地复活（2026-10-19）：确定要 lose 了，把**手势起点快照**升格为死亡快照
           （hit 填实际致命格；手势起点没有快照＝非点击路径死亡，不提供复活）。
           无猜救回成功则作废快照（盘面已被重排改写，不存在「点击前」状态） */
        dieSnap = gestureSnap ? { ...gestureSnap, hit: i } : null;
        /* 手摆局（manualBoard）无猜整体禁用：雷是玩家亲手构造的局面，
           重排会把手摆盘改写掉——踩雷直接判负 */
        if (!ng || manualBoard || isForcedMine(i)) { lose(i); return; }
        const saved = (isBlind(i) && tryNoGuess(i, true)) || tryNoGuess(i, false);
        if (!saved) { lose(i); return; }
        dieSnap = null; // 救回：本局继续，死亡快照作废
        ngRedeals++; // 一次点击触发的无猜重排＝计数 1（内部重试不计）
        ngSaves++; // 触雷被救回＝1 次（面板「无猜重排」行）
        shakeModeBtn(btnNg); // 小雨伞抖一下（2026-10-15 十期张老师定）
      } else if (ng && !manualBoard && nums![i] !== 0 && isBlind(i)) {
        const changed = tryNoGuess(i, true); // 安全盲点（数字格）：同样尽量换成 opening，盲点必开空
        if (changed) ngRedeals++;
      }
      const stack = [i];
      let openedAny = false;
      while (stack.length) {
        const c = stack.pop()!;
        if (state[c] === 1 || state[c] === 2 || mines![c]) continue;
        state[c] = 1; openedSafe++; paint(c);
        openedAny = true;
        if (nums![c] === 0) {
          for (const a of neighbors(c)) if (state[a] === 0) stack.push(a);
        }
      }
      if (openedAny) rookieAction(); // 开出格子＝有效操作（新手提示口径）
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
    /* ---- 手动摆雷模式（2026-10-21 张老师定）：自定义盘专用 ----
       入口＝自定义弹窗底部「手动摆雷」按钮；进入后弹窗收起、盘面清空待摆。
       交互：左键未摆格＝摆雷（画实雷）；右键已摆格＝取消（还原未开格）；
       触屏（无右键）点按＝toggle（摆雷中点已摆格＝取消）。摆满 M 颗前不能开局——
       所有开局手势（左键开格/双键 chord/连击/触屏）一律拦下。
       摆满后正常开局：首击那一刻 mines 定格为手摆雷区（openCell manualMode 分支），
       无猜重排整体禁用（manualBoard，见 openCell）；
       「重玩本局」复用锁定盘机制自动复刻手摆局。 */
    let manualPlaced = 0; // 已摆雷数（reset 清零）
    let manualMines: Uint8Array = new Uint8Array(0); // 手摆雷位标记（与盘面同尺寸）
    /* 手摆图常驻副本（2026-10-21 张老师定）：首击定格时存一份，之后点笑脸永远
       复玩这张图（锁定盘注入，可无限次）；只在切级别/改规格/重新摆雷时作废 */
    let manualStoredMines: Uint8Array | null = null;
    /* 摆雷拖动手势（2026-10-21 张老师补）：1=按住左键滑过连续摆 / -1=按住右键滑过连续撤 /
       0=无。不走 leftDown/rightDown（那两旗会把 mouseup 送进常规开局/插旗分支） */
    let manualDrag = 0;
    const manualBtn = $("btn_manual");
    const manualBadge = $("manual_badge");
    function syncManualBadge() {
      /* 张老师 2026-10-21 定：只显示「摆雷中 x/M」；摆满即整体隐藏（toast 已报
         完成，不留字样）——撤一颗后重新出现继续计数 */
      const full = manualPlaced >= M;
      manualBadge.hidden = full;
      if (!full) manualBadge.textContent = `（摆雷中 ${manualPlaced}/${M}）`;
    }
    /* 进入摆雷：仅自定义级别、未开局时有效；已开局则重开一局（手摆盘要全新盘面）。
       从弹窗按钮进入时先收弹窗（closeCusDialog 定义在本块之后——函数声明提升可用） */
    function startManualMode() {
      if (lv !== "cus") return;
      closeCusDialog();
      manualStoredMines = null; // 重新摆雷＝旧手摆图作废（2026-10-21 张老师定）
      if (started || over) reset("cus"); // 已开局/已结束：重开再摆
      manualMode = true;
      manualBtn.classList.add("active");
      manualBadge.hidden = false;
      container.classList.add("manual_editing"); // 盘面 crosshair 光标 + 雷位描边
      syncManualBadge();
      showToast("摆雷模式：左键摆雷，右键取消；摆满 " + M + " 颗后开始游戏");
    }
    /* 退出摆雷（切级别/重开/弹窗改规格时调）：清指示器与按钮态。
       reset 内也会清一次（manualMode=false）——这里只负责 UI 收尾 */
    function stopManualMode() {
      manualMode = false;
      manualBtn.classList.remove("active");
      manualBadge.hidden = true;
      container.classList.remove("manual_editing");
    }
    /* 摆雷动作（i＝格子下标，add=true 摆 / false 取消）。幂等：摆已摆/取消未摆零动作。
       摆雷期间 mines 尚为 null（未开局）——雷位只记在 manualMines，首击
       （openCell manualMode 分支）才整体赋给 mines；雷数 LED 同步显示剩余可摆数 */
    function manualToggle(i: number, add: boolean) {
      if (add && !manualMines[i] && manualPlaced < M) {
        manualMines[i] = 1;
        manualPlaced++;
        paintCell(cellTd(i), "bm"); // bm=cell-mine 实雷图标（与败局揭示同贴图）
        led(ledMines, M - manualPlaced);
        syncManualBadge();
        if (manualPlaced === M) showToast("摆雷完成，点击格子开始游戏");
      } else if (!add && manualMines[i]) {
        manualMines[i] = 0;
        manualPlaced--;
        paintCell(cellTd(i), "bb"); // 还原未开格
        led(ledMines, M - manualPlaced);
        syncManualBadge();
      }
    }
    on(manualBtn, "click", (e: Event) => {
      e.stopPropagation(); // 浮窗内点击不冒泡到外点关闭
      if (manualMode) { stopManualMode(); reset("cus"); return; } // 再点一次＝放弃重开
      startManualMode();
    });
    function toggleFlag(i: number) {
      if (over) return;
      if (state[i] === 1) return;
      /* 问号开关关：空白 ↔ 标雷 两态；开：空白 → 标雷 → 问号 三态循环 */
      if (state[i] === 0) { state[i] = 2; rookieAction(); } // 插上旗＝有效操作（新手提示口径）
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
       仅空手松开生效），事件流补 rc+rr 配对与常规右键同口径。
       slide=true＝滑动路径经过（2026-10-21 张老师四定汇总）：①滑动一律不做
       chord——左键滑动只开未开格，滑过已开格零动作（按住持续开空曾整路误计
       Double）；②chord 类 Double 全部「**有效才计**」——左键按下在已开格
       （三定）与右键按下/滑动过数字格（二定）统一判据：数字非 0、旗数恰好
       满足且有未开非旗邻格才触发（sc+lr 或 mr）+chord 计一次 Double；
       0 格/旗不满足/无可开的落格＝走位失误，不录事件不计 Double 零 wasted。
       病根（三定案）：初级按住左键连开整局＝多段手势（首击保护窗强制松手
       重按），落点几乎必在已开区，每次按下白计一次 Double。触屏 touchmove
       本就 state===0 守卫只开未开格，无需同改 */
    function comboLeftClick(i: number, slide = false) {
      if (state[i] === 1) {
        /* 左键滑过已开格：不双击（一审）；按下在已开格＝chord 手势，「有效才计」
           （2026-10-21 三定）：数字非 0、旗数恰好满足且有未开非旗邻格才录
           sc+lr+chord——0 格/旗不满足/无可开的按下是走位失误不是双击意图，
           不录事件不计 Double 零 wasted。病根＝初级按住左键连开整局（多段
           手势松手重按）落点几乎必在已开区上，每次白计一次 Double */
        if (slide) return;
        if (!nums || nums[i] === 0) return;
        const around = neighbors(i);
        let f = 0;
        for (const c of around) if (state[c] === 2) f++;
        if (f !== nums[i] || !around.some((c) => state[c] === 0)) return;
        comboHit = true; recordEv(11, i); recordEv(5, i); chord(i);
      }
      else if (state[i] === 0) {
        /* 开局保护窗内跳雷（2026-10-22 二定；时长三定＝初级 0/其余 500ms）：
           安全格照常开，仅有雷格被跳过（无事件零动作）。首格＝首击入口
           （openCell 内 placeMines 前 nums 尚空、mines 也尚未生成），判据
           天然放行；窗口到期后雷格也照常触发 */
        if (comboShield() && mines && mines[i]) return;
        comboHit = true; recordEv(3, i); recordEv(5, i); openCell(i);
      }
    }
    function comboRightClick(i: number, slide = false) {
      if (nf) return; // NF：右键禁用（入口已拦，双保险）
      if (autoChord && nums && state[i] === 1) {
        /* 连击模式右键在已开数字格上（按下与滑动同口径，「有效才计」）：
           旗数恰好满足且有未开非旗邻格才 mr+chord；否则静默跳过 */
        if (nums[i] === 0) return;
        const around = neighbors(i);
        let f = 0;
        for (const c of around) if (state[c] === 2) f++;
        if (f !== nums[i] || !around.some((c) => state[c] === 0)) return;
        comboHit = true; recordEv(65, i); chord(i); return;
      }
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
      /* 复活次数行（2026-10-19 张老师定）：金色数值（#fdc61d 站内黄），hover＝
         原地复活说明；只有复活过的局才显示（revives>0） */
      if (revives > 0)
        rows.push(["复活次数", String(revives), "原地复活（回滚踩雷点击）的次数，复活后计时继续", "gv_rv"]);
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
         sendBeacon 不阻塞下一局，关页/刷新也不丢；失败静默（埋点不影响游戏）。
         原地复活（2026-10-19）：**败局延迟 300ms 发送**——踩雷后 300ms 内按空格/
         点复活按钮则撤销（那局还没完，败局不是终态）；胜局立即发（没有复活可推翻） */
      if (t > 0) {
        try {
          const payload = JSON.stringify({
            level: lv, won, csec: Math.round(t * 100), bbbv: board3bv,
            solvedBv, nf, clicks: cnt.clLeft + cnt.clRight + cnt.clDouble,
          });
          if (won) {
            navigator.sendBeacon("/api/track/practice", new Blob([payload], { type: "application/json" }));
            bumpLocalPractice(); // 未登录「今日练习」记数（2026-10-22）：胜局终态立即 +1
          } else {
            if (pendingLoseBeacon !== null) clearTimeout(pendingLoseBeacon);
            pendingLoseBeacon = window.setTimeout(() => {
              navigator.sendBeacon("/api/track/practice", new Blob([payload], { type: "application/json" }));
              bumpLocalPractice(); // 败局复活窗（300ms）结束后才算终态，此时 +1
              pendingLoseBeacon = null;
            }, 300);
          }
        } catch { /* ignore */ }
      }
      /* 数据面板只在「显示统计」开着时、且只在**游戏结束**这一刻出现
         （2026-10-15 八期张老师定：对局中不再常驻实时刷新）；再开局由 reset 撤下。
         十期补：无论开关与否都定格一份 HTML，供局后补开开关时立即补弹本局面板 */
      lastReportHtml = html;
      if (showStats) paintStatPanel(html);
      buildResultPanel(t, solvedBv, won, cnt);
    }
    /* ---- 右侧结算面板（五期）：雷达图 + 再来一局 / 重玩本局 / 查看回放 / 下载录像 ----
       imported=true＝拖拽导入局（2026-10-21）：快照带来源标记（回放播完即退出口径） */
    function buildResultPanel(t: number, solvedBv: number, won: boolean, cnt: ReplayCounts, imported = false) {
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
        imported,
        manual: manualBoard, // 手摆局标记：R 重玩复刻后延续无猜禁用口径（防重排改写手摆图）
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
      maskDelaySeq++; // 结算代际 +1：旧延时定时器自此失效（见 renderResultPanel 尾部）
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
      /* 综合评级走共享件（2026-10-16）：五轴组内分位加权，全屏试玩「我的评级」同一份算法。
         复活降档（2026-10-19 张老师定）：每原地复活一次，雷达「判雷」轴（原「综合」）
         的档位强制降一级——**先独立计算，再加修正**（demoteGrade 按九档主档下移、
         最低 F）。降档作用于判雷轴的 grade 与标题「评级：X」两处（标题评级里
         STNB 权重占一半，判雷被罚降则整体评级同步降，口径一致）；速度/效率/
         精准/手速四根分项轴不受影响（复活惩罚只打在「判雷」上） */
      const perfGradeRaw = radarOverall(pts);
      const demoted = perfGradeRaw !== "?" && revives > 0;
      const perfGrade = demoteGrade(perfGradeRaw, revives);
      if (demoted && pts[0]?.grade !== "?") pts[0] = { ...pts[0], grade: demoteGrade(pts[0].grade, revives) };
      const lvName = (LEVEL_NAMES as Record<string, string>)[s.level] ?? "自定义";
      /* 预计完成用时（十一期）：Est RTime 同口径，半角括号整体小号亮灰 */
      const estSec = s.stats.solvedBv > 0 ? (s.csec / 100) * (s.bbbv / s.stats.solvedBv) : 0;
      const lvSpan = s.won
        ? '<span class="gr_lv">' +
          lvName +
          '<em class="lv_' + s.level + '">' + (s.csec / 100).toFixed(2) + "</em>秒" +
          (s.nf ? "<ins>NF</ins>" : "") +
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
        /* 原地复活＝心电脉冲：一条心电图折线穿过一颗实心心形——「从死亡线上
           拉回来」的直觉符号；stroke 风格与上面四颗同款（2026-10-19 设计） */
        revive:
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M1.5 12h3.6l1.9-5.5L11 18l2.2-7.6 1.3 1.6h7.9"/><path fill="currentColor" d="M11.99 10.1c.45-1.55 2.6-1.85 3.5-.6.8 1.1.3 2.6-1 3.75L12 15.4l-2.5-2.15c-1.3-1.15-1.8-2.65-1-3.75.9-1.25 3.05-.95 3.49.6z"/></svg>',
      };
      /* 渲染目标恒为 #gresult 本体（2026-10-19 二版）：遮罩态下这个节点被搬进
         #grm_result 槽、侧边态下在 #game_area——宿主切换交给 syncReportZoom 统一搬，
         这里只管把内容写进唯一那份 DOM（#gr_radar / 按钮 id 全文档恒一份） */
      const host = gresult;
      gresult.innerHTML = "";
      /* 原地复活按钮（2026-10-19 张老师定）：**仅败局且有死亡快照**在雷达图下方
         额外一颗黄色按钮（与四按钮分开、独占一行），点击或空格触发 revive；
         胜局/首击即雷（无快照）不渲染。渲染条件与 revive()/空格守卫同源：
         dieSnap 存在。独占整行宽度充裕，「空格」键帽恒显示（2026-10-19 快捷键标注；
         触屏设备不渲染键帽与键盘 title——2026-10-21 张老师定，没有键盘不提快捷键） */
      const kb = (k: string) => (touchUI ? "" : "<kbd>" + k + "</kbd>");
      const reviveBtn = !s.won && dieSnap && reviveOn
        ? '<button type="button" class="grb grb_revive" id="grb_revive"' +
          (touchUI ? "" : ' title="按空格也可复活"') + ">" +
          IC.revive + '原地复活' + kb("空格") + "</button>"
        : "";
      /* 四个按钮分两行（2026-10-15 六期张老师定）：上排＝开局类（再来一局 / 重玩本局），
         下排＝本局录像类（查看回放 / 下载录像）。.gr_btns 走 2 列 grid，DOM 顺序即行列顺序。
         快捷键键帽（2026-10-19 张老师定）：R/A/V/D 与按钮一一对应；侧边窄面板
         （列宽 ~84px）放不下由 CSS container query 自动隐藏（.gr_btns 容器宽
         ≥240px 才显示 kbd），遮罩卡片/宽面板下显示；
         触屏设备整个不渲染键帽（2026-10-21 张老师定：移动端没有键盘） */
      host.innerHTML =
        titleLine +
        '<div class="gr_radar" id="gr_radar"></div>' +
        reviveBtn +
        '<div class="gr_btns">' +
        '<button type="button" class="grb" id="grb_new_game">' + IC.newGame + '再来一局' + kb("A") + "</button>" +
        '<button type="button" class="grb" id="grb_replay_same">' + IC.replaySame + '重玩本局' + kb("R") + "</button>" +
        '<button type="button" class="grb" id="grb_review">' + IC.review + '查看回放' + kb("V") + "</button>" +
        '<button type="button" class="grb" id="grb_download">' + IC.download + '下载录像' + kb("D") + "</button>" +
        "</div>";
      /* 显隐标志与宿主（2026-10-19 二版）：.show 一律置上＝「这局要显示」，
         至于摆侧边还是进遮罩卡片，由 syncReportZoom 按空间判定后搬家 */
      gresult.classList.add("show");
      maskOpen = true;
      /* 雷达图恒显示（2026-10-15 张老师定）：自定义盘参照高级基准评级；
         缺基准 / 完成度过低 → 空雷达（全轴 ?、收缩到圆心），hover 提示「参考数据不足，无法评级」。
         ⚠️ 不写 inline display——CSS（.gr_radar）是 flex 居中容器（2026-10-20 张老师定
         「雷达图任何时候在板块内居中」）：inline display:block 会压死 flex，钳宽后的
         雷达（.vr_wrap max-width）就失去居中锚点了 */
      const radarHost = host.querySelector("#gr_radar") as HTMLElement | null;
      if (radarHost) {
        /* 复用录像详情页的 VideoAnalysisRadar 组件（张老师 2026-10-14 定：不该再维护第二份
           绘制）。面板是 innerHTML 注入流、JSX 挂不进去，所以用 createRoot 把 React 组件挂到
           占位 div —— 文案/字号/气泡样式与录像页**由同一个组件保证同源**，不会再分叉。
           fill 模式（八期 2026-10-15 张老师定）：宽度顶满面板内容宽，不再给固定边长
           ⚠️ 必须 flushSync 同步 commit（2026-10-21 张老师报「初级结算面板反复横跳」根因）：
           concurrent 调度下 render() 返回时 DOM 未落地，下方 syncReportZoom 立刻量高度，
           拿到的是「无雷达」的假小高度（~120px，真实含雷达 ~290px）→ panelBase 缓存被
           污染 → 高度封顶（不得超游戏窗高 / 不得超数据面板高）全部失守 → 面板放大；
           雷达随后落地，高度暴涨，且再无代码回收。是否失守取决于 React 调度与渲染帧的
           时序竞争，初级封顶本来就压着（中高级不压）故只初级肉眼可见、时大时正常。
           flushSync 让 DOM 在本行同步落地，竞争从根上消失 */
        const root = createRoot(radarHost);
        flushSync(() => root.render(<VideoAnalysisRadar data={pts} fill onMount={radarMounted} />));
        radarRootRef.current = root;
      }
      /* 全屏遮罩延时 500ms 弹出（2026-10-20 张老师定）：新结算正处全屏时，给玩家
         半秒看清盘面（败局红雷在哪死的/胜局终盘）再盖遮罩——立即弹出太突兀。
         · **必须在下面 syncReportZoom 之前武装**：enterMask 见 timer 挂着就不翻
           grModal.hidden，延时才真正生效（宿主搬家/几何计算照常同步落定）；
         · 到点复核：结算代际变了（又开了一局）/ 面板已撤（reset/复活/进回放都走
           hideResultModal 取消定时器，此处兜底）/ 已回侧边宿主（侧边本就可见，
           无「遮盖突兀」可谈）则不弹；窗口模式遮罩（窄屏/移动端）没有盖住整个
         游戏画面的突兀感，不延时——只在全屏结算这一刻武装；
         · 500ms 内退出全屏：仍按到点弹（此时若空间够早已被 resize 路径搬回
           侧边、回调见 panelSlot!=="mask" 自然不弹；仍是遮罩态则弹出正确） */
      if (document.fullscreenElement === root) {
        const bornAt = maskDelaySeq;
        if (maskDelayTimer !== null) clearTimeout(maskDelayTimer);
        maskDelayTimer = window.setTimeout(() => {
          maskDelayTimer = null;
          if (bornAt !== maskDelaySeq) return;
          if (!maskOpen) return;
          if (panelSlot !== "mask") return;
          grModal.hidden = false;
          fitMaskCard();
        }, 500);
      }
      /* 显形后立刻定位缩放：数据面板关着时 syncReportZoom 不再被 paintStatPanel 带动
         （那是「面板小、叠棋盘左上」bug 的另一半——游戏结束这刻也无人调用）。
         雷达是 createRoot 异步渲染、首帧量不到高度，再排一帧复核；遮罩态卡片是按
         卡片实测尺寸放大缩小的，首帧量矮了会把卡片放过头 → 90ms 后再补一次 */
      syncReportZoom();
      requestAnimationFrame(syncReportZoom);
      window.setTimeout(() => { if (panelSlot === "mask") fitMaskCard(); }, 90);
      const bind = (id: string, fn: () => void) => {
        const el = host.querySelector("#" + id) as HTMLElement | null;
        if (el) on(el, "click", fn);
      };
      bind("grb_new_game", newGame);
      bind("grb_replay_same", replaySameBoard);
      bind("grb_review", startInPlaceReplay);
      bind("grb_download", downloadAvf);
      bind("grb_revive", revive);
    }
    /* 结算浮层收起 / 再弹（七期 2026-10-15；2026-10-19 二版扩到桌面遮罩态）。
       收起**不清内容**——只是 hidden，再弹不必重建（雷达 React root 留在卡片里，
       hidden 期间不响应 hover，无副作用；内容只在新一局结算时被重写）。
       maskOpen 与 panelSlot 分开记：前者＝「遮罩此刻该不该展开」（点遮罩关掉后
       再 resize 不能自己弹回来），后者＝「面板住在哪」（空间不够就得一直住在卡片里） */
    function hideResultModal() {
      maskOpen = false;
      /* 延时弹出窗口内被撤（新局 reset/复活/进回放）：定时器一并取消，
         否则 500ms 后遮罩自己弹出来 */
      if (maskDelayTimer !== null) {
        clearTimeout(maskDelayTimer);
        maskDelayTimer = null;
      }
      grModal.hidden = true;
    }
    function showResultModal() {
      if (!snapshot) return;
      maskOpen = true;
      /* 侧边态的面板常驻可见，没有「再弹」这回事；只有遮罩态需要重新展开 */
      if (panelSlot !== "mask") return;
      grModal.hidden = false;
      fitMaskCard();
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
    /* ---- 重玩本局：复刻结束时的地图注入锁定盘；无猜保持原状不强制关闭
       （2026-10-19 张老师两定：偏好不被重玩按钮破坏；重玩局内无猜照常救回，
       允许盘面漂移） ---- */
    function replaySameBoard() {
      if (!snapshot) return;
      replayBoardLocked = true; // 标记：下一局布雷走锁定盘
      pendingBoard = snapshot.mines.slice();
      const wasManual = !!snapshot.manual; // 先取（reset 会清 manualBoard）
      reset(lv === "cus" ? "cus" : lv);
      /* 手摆局快照：复玩局延续 manualBoard=true——无猜不救回（救回会重排
         改写手摆图，违背 2026-10-21 张老师定「不切模式/不重摆就一直不换图」）。
         普通局快照维持 10-19 口径：无猜照常救回，允许盘面漂移 */
      if (wasManual) manualBoard = true;
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
         即收起浮层，播完再弹回来（见 exitReplay / tick 的收尾）。
         二版起桌面遮罩态同理（面板也在浮层里），一并收起 */
      hideResultModal();
      const s = snapshot;
      /* 结算终值存档（二十期）：回放期间计数条被征用（计时/雷数 LED 随回放走），
         退出回放恢复到这里存的读数；倍率同理——若为装下控制条自动缩小过，
         退出时还原（玩家回放中手动动过倍率则尊重现状不还原） */
      const savedTimeLed = ledTimeCur, savedMinesLed = ledMinesCur;
      const savedZoom = zoomCur;
      let shrankTo: number | null = null;
      replaying = true;
      rookieStop(); // 新手提示：回放征用盘面，提示层必须撤（退出回放由结算态自然不激活）
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
          /* 遮罩态（移动端 / 二版桌面挤爆时）：浮层是带遮罩的全屏层，回放停在原地会被它
             盖住、连退出入口都摸不到——播完直接退出回放并重新弹出「本局表现」浮层。
             侧边态浮窗本来就在盘面旁常驻，保持原样（回放停在终局画面）。
             拖拽导入局（2026-10-21 张老师定「播完像刚打完一样」）：无论宿主形态，
             播完都退出回放、恢复引擎终态（败局揭示雷区/胜局全旗）——exitReplay 里
             repaintAll 按注入的 state 重画，就是终局定格画面 */
          if (!mqPanelDesktop.matches || panelSlot === "mask" || s.imported) exitReplay();
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
      /* 再弹结算浮层（七期移动端 / 二版桌面遮罩）：侧边态的面板没被收起过，
         showResultModal 内部按宿主自己判断 */
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
    /* ---- 拖拽导入录像（2026-10-21 张老师定）：把录像文件拖到页面 → 本页原地自动回放，
       播完的界面就像刚打完一局（结算面板齐备），「重玩本局」即可重试这盘地图 ----
       链路与站内完全同源：avf/mvf（mvf-best 择优）/rmv → rawvf 行 → formatRawvf
       结构化 → videowin 判定胜负 → 重放终态注入引擎 → buildResultPanel 出结算面板
       → startInPlaceReplay() 原地自动播放。盘面级别按录像规格走（标准三级按原级别，
       其余 cus；重玩锁定盘首击注入原雷区——与站内「重玩本局」完全同路）；导入局
       不发 practice_log 埋点、下载的 AVF 带 Online 标记照旧不占排行。 */
    let importedName = ""; // 最近一次拖入的文件名（dev 钩子 / 调试用）
    /** rawvf 事件行解析：`ts ev col row (px py)` → OnlineEvent。
        ⚠️ mv（鼠标移动）必须收——事件名→码表带上 mv:1（2026-10-21 张老师报
        「拖入回放鼠标轨迹丢细节」根因：mv 不在反查表里，111 条移动事件全被
        continue 丢弃，光标只剩点击点之间的直线插值，对比自打局回放的顺滑轨迹
        「细节全丢」）；越界坐标不裁剪——回放引擎自带 inside 判定。
        ⚠️ 反查表只收**标准码**（lc=3/lr=5/rc=9/rr=17/sc=11/mr=65）——MOUSE_CODE_TO_EV
        还带 21:"lr"/145:"rr"/193:"mr" 三个变体码（Arbiter 某些版本产出），无脑
        反查会让变体码覆盖标准码（lr 变 21），页内回放引擎 applyEv 的 switch 不认
        变体码 → 首击 lr 永不 flood、整盘「只有光标动」（2026-10-21 张老师上传
        Exp 4.74s 实锤：事件流第 2 条就是 mouse=21） */
    const EV_NAME_TO_MOUSE: Record<string, number> = { mv: 1, lc: 3, lr: 5, rc: 9, rr: 17, sc: 11, mr: 65 };
    function importDroppedVideo(buf: Uint8Array, extIn: string): string | null {
      /* ① 解析：按扩展名分发，mvf 走 mvf-best 择优（判定与回放同源，站内口径） */
      let lines: string[] | null = null;
      try {
        lines =
          extIn === "avf"
            ? avfToRawvf(buf)
            : extIn === "mvf"
              ? (mvfToRawvfBest(buf)?.lines ?? null)
              : extIn === "rmv"
                ? rmvToRawvf(buf)
                : null;
      } catch {
        return "文件已损坏，无法解析";
      }
      if (!lines) return "无法识别的录像文件（支持 avf / mvf / rmv）";
      const v = formatRawvf(lines);
      if (!v.width || !v.height || v.board.length !== v.width * v.height)
        return "录像数据不完整";
      const outcome = judgeVideoOutcome({
        width: v.width, height: v.height, board: v.board, events: v.events, marks: v.marks,
      });
      if (outcome === "incomplete") return "这不是一局完整的录像";
      const won = outcome === "win";
      /* ② 雷区/数字重建（board 串：'*'=雷，其余=数字字符） */
      const N = v.width * v.height;
      const bMines = new Uint8Array(N);
      const bNums = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (v.board[i] === "*") bMines[i] = 1;
        else bNums[i] = v.board.charCodeAt(i) - 48;
      }
      /* ③ 事件流解析 + 终态重放（flop 状态机 1:1，与页内回放 applyEv 同语义） */
      const evs: OnlineEvent[] = [];
      for (const line of v.events) {
        const m = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
        if (!m) continue;
        if (m[2] === "mt") continue; // 问号开关切换：无对应交互事件，跳过
        const code = EV_NAME_TO_MOUSE[m[2]];
        if (code === undefined) continue;
        const sec = Math.floor(parseFloat(m[1]));
        evs.push({ mouse: code, x: +m[5], y: +m[6], sec, hun: Math.round((parseFloat(m[1]) - sec) * 100) });
      }
      if (!evs.length) return "录像里没有任何操作事件";
      const finalSec = evs[evs.length - 1].sec;
      const rstate = new Uint8Array(N); // 0 未开 1 开 2 旗 3 问号
      let rLp = false, rRp = false, rSv = false;
      const inside = (px: number, py: number) => px >= 0 && px < v.width * 16 && py >= 0 && py < v.height * 16;
      const cellOf = (px: number, py: number) => ((py / 16) | 0) * v.width + ((px / 16) | 0);
      const flood = (i: number) => {
        const stack = [i];
        while (stack.length) {
          const c = stack.pop()!;
          if (rstate[c] === 1 || rstate[c] === 2 || bMines[c]) continue;
          rstate[c] = 1;
          if (bNums[c] === 0)
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const x = (c % v.width) + dx, y = ((c / v.width) | 0) + dy;
              if (x >= 0 && x < v.width && y >= 0 && y < v.height && rstate[y * v.width + x] === 0) stack.push(y * v.width + x);
            }
        }
      };
      const chord = (i: number) => {
        if (rstate[i] !== 1 || bNums[i] === 0) return;
        const x = i % v.width, y = (i / v.width) | 0;
        let f = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < v.width && ny >= 0 && ny < v.height && rstate[ny * v.width + nx] === 2) f++;
        }
        if (f !== bNums[i]) return;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < v.width && ny >= 0 && ny < v.height && rstate[ny * v.width + nx] === 0)
            flood(ny * v.width + nx);
        }
      };
      for (const e of evs) {
        const ci = inside(e.x, e.y) ? cellOf(e.x, e.y) : -1;
        switch (e.mouse) {
          case 3: rLp = true; break; // lc
          case 5: // lr
            if (ci >= 0) { if (rRp || rSv) chord(ci); else flood(ci); }
            rLp = false; rSv = false;
            break;
          case 9: // rc（lp 按住仅视觉）
            if (!rLp && ci >= 0) {
              if (rstate[ci] === 0) rstate[ci] = 2;
              else if (rstate[ci] === 2) rstate[ci] = v.marks ? 3 : 0;
              else if (rstate[ci] === 3) rstate[ci] = 0;
            }
            rRp = true;
            break;
          case 17: if (rLp && ci >= 0) chord(ci); rRp = false; break; // rr
          case 11: rLp = true; rSv = true; break; // sc
          case 65: if (ci >= 0) chord(ci); break; // mr
          default: break; // mv
        }
      }
      /* 胜局：未标旗的雷全部记旗（checkWin 自动补旗的终态口径） */
      if (won) for (let i = 0; i < N; i++) if (bMines[i] && rstate[i] === 0) rstate[i] = 2;
      /* ④ 终态统计（重放引擎跑权威计数；won 时不重放已无必要——直接算） */
      const cnt = replayCounts(
        { width: v.width, height: v.height, mines: v.mines, board: bMines },
        evs.map((e) => ({
          ev: MOUSE_CODE_TO_EV[e.mouse] ?? "mv",
          x: (e.x / 16) | 0, y: (e.y / 16) | 0, px: e.x, py: e.y,
        })),
        { marks: v.marks }
      );
      /* ⑤ 注入引擎：cus（自定义规格）/ 标准级别都交给 reset 自行设尺寸——
         ⚠️ 绝不在此手动改 W/H/M/lv：reset 的 gridChanged 对比「进入时 W/H」，
         提前赋值会把 gridChanged 钉成 false、tbody 不重建，旧盘行列对不上新盘
         直接炸 paintCell（cells[x] undefined）。
         ⚠️ 级别判定**不看胜负**（2026-10-21 张老师报：高级踩雷局存下来变 Cus）——
         只要规格恰好是标准三级（含踩雷局）就按原级别走，重下载文件名/雷区 tab
         才能对得上；自定义规格才落 cus */
      const targetLv =
        v.width === 8 && v.height === 8 && v.mines === 10 ? "beg"
        : v.width === 16 && v.height === 16 && v.mines === 40 ? "int"
        : v.width === 30 && v.height === 16 && v.mines === 99 ? "exp"
        : "cus";
      if (targetLv === "cus") cusSpec = { w: v.width, h: v.height, m: v.mines };
      if (won) { replayBoardLocked = true; pendingBoard = bMines.slice(); }
      reset(targetLv);
      mines = bMines.slice();
      nums = bNums.slice();
      origMines = mines.slice();
      state = rstate.slice();
      /* 败局终局揭示（2026-10-21）：把未插旗的雷格直接写进 state＝1（引擎 lose()
         的 DOM 揭示不进 state，但 exitReplay 走 repaintAll 按 state 重画——不写
         进 state 的话退出回放后雷区揭示会消失）；踩中格＝重放中最后一个被开的
         雷格（flood 拒开雷，正常重放里雷格恒 0——踩雷在真实对局由引擎 lose 标
         hitIdx，这里从事件流反查最后一个落在雷格上的开格动作） */
      if (!won) {
        let hitCell = -1;
        let rp2 = false, sv2 = false;
        for (const e of evs) {
          const ci = inside(e.x, e.y) ? cellOf(e.x, e.y) : -1;
          if (e.mouse === 11) sv2 = true;
          else if (e.mouse === 5) {
            if (ci >= 0 && mines[ci] && !(rp2 || sv2)) hitCell = ci; // 左键开在雷上＝踩雷
            sv2 = false;
          } else if (e.mouse === 9) rp2 = true;
          else if (e.mouse === 17) rp2 = false;
        }
        for (let i = 0; i < N; i++) if (mines[i] && state[i] !== 2) state[i] = 1;
        hitIdx = hitCell >= 0 ? hitCell : null;
      } else hitIdx = null;
      started = true;
      over = true;
      openedSafe = 0;
      for (let i = 0; i < N; i++) if (state[i] === 1 && !mines[i]) openedSafe++;
      totalSafe = N - v.mines;
      evStream = evs;
      /* 3BV 构件照 placeMines 锁定盘口径重建（compute3BV 读全局 mines/nums） */
      compute3BV();
      if (v.bbbv && v.bbbv > 0) board3bv = v.bbbv; // 文件头权威值优先
      /* ⑥ 结算（report 不走——埋点是玩家真实练习口径，导入局不发） */
      const tSec = Math.max(finalSec / 100, v.timeMs / 1000, 0.01);
      const { solvedBv, html } = statsReport(tSec, cnt);
      lastReportHtml = html;
      if (showStats) paintStatPanel(html);
      buildResultPanel(tSec, solvedBv, won, cnt, true);
      /* 败局错旗（flag 标在非雷格上＝bn）：repaintAll 按 td 类名 contains("bn") 保留，
         引擎 lose() 靠 DOM 类名传递——导入路径没有这一步，必须在 repaintAll 之前
         先画上（画完 repaintAll 才能识别并保留） */
      if (!won) for (let i = 0; i < N; i++) if (!bMines[i] && state[i] === 2) paintCell(cellTd(i), "bn");
      repaintAll();
      led(ledMines, won ? 0 : v.mines - cnt.flags);
      led(ledTime, Math.floor(tSec));
      setFace(won ? "win" : "dead");
      /* ⑦ 原地自动回放（与「查看回放」同路）；导入局播完即退、定格引擎终态
         （败局揭示雷区/胜局全旗——「像刚打完一样」，快照 imported 标记驱动） */
      startInPlaceReplay();
      return null;
    }
    /* ---- 拖拽落点（2026-10-21）：全页拖入录像文件即导入；拖拽悬停高亮 ----
       dragover 必须 preventDefault 否则浏览器直接打开文件；drop 里读 File →
       ArrayBuffer → importDroppedVideo。失败弹红色气泡（站内错误红 #f92672）。 */
    const dropHint = document.createElement("div");
    dropHint.id = "op_drop_zone"; // 提示文案由 CSS ::before 出（JS 不设文本，避免双份）
    container.appendChild(dropHint);
    let dragDepth = 0;
    function hasFiles(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).includes("Files");
    }
    on(container, "dragenter", (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      dropHint.classList.add("on");
    });
    on(container, "dragover", (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // 不拦就变成浏览器打开文件
    });
    on(container, "dragleave", () => {
      if (--dragDepth <= 0) { dragDepth = 0; dropHint.classList.remove("on"); }
    });
    on(container, "drop", async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropHint.classList.remove("on");
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      importedName = f.name;
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const err = importDroppedVideo(buf, ext);
        if (err) showToast("导入失败：" + err, true);
      } catch {
        showToast("导入失败：文件读取错误", true);
      }
    });
    /* ---- 原地复活执行（2026-10-19 张老师定）：回滚上次踩雷的点击，时间继续 ----
       触发：结算面板黄色「原地复活」按钮（空格键快捷触发）。
       动作：恢复死亡快照（盘面/雷区/数字/3BV 构件/事件流截断）→ over=false
       → 计时器从死亡时刻续跑（elapsed 偏移 = startTs 前移死亡经过的时长，表针连续）
       → 败局埋点撤销（这局还没完）→ 复活计数+1 → 撤结算面板（含移动端浮层）。
       ⚠️ 恢复路径全部走既有函数：repaintAll 重画盘面（over=false 时按 state 画，
       不再揭示雷区）、led 恢复雷数计数、setFace 回笑脸。手雷数由 flagsLeft 重算
       （快照里 state 含玩家旗，重算即死亡前 LED 值）。 */
    function revive() {
      /* 三重守卫：死亡快照存在、确实在结算态、终态是**败局**（胜局快照/救回后
         作废的 null 都不触发——空格键与按钮同路）；「允许复活」开关关闭时
         一并拦截（按钮不渲染、空格不劫持，此处兜底防 __op 等旁路触发） */
      if (!reviveOn || !dieSnap || !over || snapshot?.won) return;
      const d = dieSnap;
      state = d.state.slice();
      openedSafe = d.openedSafe;
      mines = d.mines.slice();
      nums = d.nums.slice();
      bvRegions = d.bvRegions.map((r) => r.slice());
      bvSingles = d.bvSingles.slice();
      bvIslands = d.bvIslands.map((r) => r.slice());
      board3bv = d.board3bv;
      origMines = d.origMines ? d.origMines.slice() : null;
      evStream.length = d.evLen; // 截断：致命点击及之后的事件（雷揭示 paint 不录事件，天然无需处理）
      over = false;
      hitIdx = null;
      /* 计时续跑（「时间继续」的题意）：startTimer 会把 startTs 重置为 now，
         先起表、再把 startTs 回拨到死亡时刻——elapsed 恰从 d.csec 续走、LED 表针
         无跳变（回滚语义：致命点击不存在，用时也从点击那一刻继续） */
      startTimer();
      startTs -= d.csec * 10;
      /* 败局埋点撤销 + 复活计数 */
      if (pendingLoseBeacon !== null) { clearTimeout(pendingLoseBeacon); pendingLoseBeacon = null; }
      revives++;
      /* 盘面与计数恢复：repaintAll 在 over=false 下按 state 重画（含旗/数字），
         死亡揭示的红雷/错旗贴图一并被覆盖掉；败局快照作废（这局还没完） */
      gresult.classList.remove("show");
      greport.classList.remove("show");
      snapshot = null;
      hideResultModal();
      repaintAll();
      led(ledMines, d.minesLed);
      setFace("smile");
      dieSnap = null; // 一次性：复活后再踩雷会重新拍摄
      gestureSnap = null; // 手势快照同步作废（新手势会重拍）
      rookieLastAct = performance.now(); // 新手提示：复活后重新计闲置（lose 里已停）
      showToast("已复活，时间继续");
    }

    function lose(hit: number) {
      over = true;
      rookieStop(); // 新手提示随局终停止（雷区已全部揭示，提示无意义）
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
      rookieStop(); // 新手提示随局终停止
      const t = stopTimer();
      report(t, true); // 须在自动补旗之前：Flags 只算玩家实际插的
      for (let i = 0; i < mines!.length; i++) if (mines![i] && state[i] !== 2) { state[i] = 2; paint(i); }
      led(ledMines, 0);
      setFace("win");
      /* 胜利同样不再有任何文字提醒（数据都在左侧报告浮窗里） */
    }

    /* ---- 新手提示（2026-10-19 张老师定）：闲置 3 秒标出 100% 确定的雷与安全格 ----
       交互口径（张老师原话拆解，四版 2026-10-20 全图模式）：
       · 有效操作只有两种——标雷（插上旗）、开空（开出格子）；点击/移动鼠标不算
       · 连续 3 秒无有效操作 → 激活；**全图**标示（不再限定鼠标半径——提示内容
         与鼠标位置无关，鼠标挪窝不重算不跳动）：
         可 100% 确定的雷 → 半透明雷图标（op-hint-mine 类，矢量层叠 #cell-mine 半透明）
         可 100% 确定不是雷的未开格 → 静态绿框标示（op-hint-safe，二版不闪烁）
       · 三期（2026-10-20；同日二改）：确定安全格全部已开（无可再打开的格子）→
         雷概率最低的未开前沿格标黄（op-hint-low，并列全标，50/50 死猜两格皆黄）；
         概率 = 分量枚举的为雷解数 ÷ 总解数；必雷格是否已插旗不影响触发
       · 出现后持续显示：激活时刻的格子集合定格（rookieShown），期间新开的格子
         从显示中摘除（不再进入提示）；本轮绿格全部打开后整层收起，闲置满 3 秒
         再激活时按新盘面重新计算；纯黄提示（无可开绿格）持续到局终/重开/关开关
       · 局终（胜/负/复活）/重开/进回放一律停；提示纯视觉层，不落任何事件流、
         不动 state/mines，对录像/统计零影响（覆盖层只叠加在未开格 bb 上，任何
         paint 都会整格重写、自然清掉提示，无需逐格手工回收）
       推理口径（保守优先，宁可漏报绝不误报）：对每个前沿连通分量独立全枚举
       （每个已开数字的隐藏邻格雷数＝数字值），恒雷 → 必雷、恒空 → 必安全；
       **不联立全局总雷数约束**（M−旗 数作上界裁枝会引入「玩家旗可能标错」的
       依赖——提示只在「所有可行布局下都成立」时报，旗错时宁可不出提示）。
       问号/旗格不参与任何提示（它们不是「未打开」的未知格语义） */
    const rookieLayer: SVGSVGElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    rookieLayer.setAttribute("class", "hintboard");
    rookieLayer.setAttribute("aria-hidden", "true");
    function rookieHintSet(): { mines: number[]; safe: number[]; low: number[] } {
      /* 前沿格收集（已开数字的未开邻居）；约束图按共享前沿格连通成分量 */
      const n = W * H;
      const inFrontier = new Uint8Array(n);
      const clues: number[] = [];
      for (let i = 0; i < n; i++) {
        if (state[i] !== 1 || !nums || nums[i] === 0) continue;
        let has = false;
        for (const a of neighbors(i)) {
          if (state[a] !== 1) { inFrontier[a] = 1; has = true; }
        }
        if (has) clues.push(i);
      }
      /* clue 连通分量（共享前沿格即同分量）：分量内独立枚举，规模可控
         （实战分量 ≤ 数十字；99×99 自定义极端盘上限 20 万节点兜底防卡） */
      const compOf = new Int32Array(clues.length).fill(-1);
      const comps: { clues: number[]; vars: number[] }[] = [];
      const clueLocal = new Map<number, number>();
      clues.forEach((c, k) => clueLocal.set(c, k));
      for (let k = 0; k < clues.length; k++) {
        if (compOf[k] >= 0) continue;
        const cid = comps.length;
        const cl: number[] = [], vl: number[] = [];
        const stack = [k];
        compOf[k] = cid;
        while (stack.length) {
          const cur = clues[stack.pop()!];
          cl.push(cur);
          for (const a of neighbors(cur)) {
            if (state[a] !== 1 && inFrontier[a]) {
              vl.push(a);
              for (const c2 of neighbors(a)) {
                const lk = clueLocal.get(c2);
                if (lk !== undefined && compOf[lk] < 0) { compOf[lk] = cid; stack.push(lk); }
              }
            }
          }
        }
        comps.push({ clues: cl, vars: vl });
      }
      const couldMine = new Uint8Array(n), couldSafe = new Uint8Array(n);
      /* 前沿格雷概率（三期 2026-10-20 张老师定）：分量内条件概率 = 为雷解数 ÷ 总解数；
         -1 = 非前沿格 / 分量超限无数据。用于确定性提示耗尽后的「低概率格标黄」 */
      const prob = new Float64Array(n).fill(-1);
      let nodes = 0;
      const NODE_CAP = 400000; // 全部分量共享的节点预算（上界剪枝后中高级盘远用不满）
      for (const comp of comps) {
        const vlist = Array.from(new Set(comp.vars));
        const vIdx = new Map<number, number>();
        vlist.forEach((v, t) => vIdx.set(v, t));
        const F = vlist.length;
        const mineCnt = new Int32Array(F), openCnt = new Int32Array(F);
        /* 每个 clue 的成员格表（转置成 cluesOfVar[t]，DFS 每层只扫自己的 clue） */
        const clueVars: number[][] = comp.clues.map((c) => {
          const arr: number[] = [];
          for (const a of neighbors(c)) if (vIdx.has(a)) arr.push(vIdx.get(a)!);
          return arr;
        });
        const cluesOfVar: number[][] = Array.from({ length: F }, () => []);
        clueVars.forEach((vars, ci) => { for (const v of vars) cluesOfVar[v].push(ci); });
        const need0 = comp.clues.map((c) => nums![c]);
        const free0 = clueVars.map((v) => v.length);
        let overflow = false;
        /* 枚举分量全部可行解（val 1=雷 0=空）：带双向剪枝（与 noGuessOnce 同款）——
           ① 下界：某 clue 的剩余需求 need < 0（雷放多了）→ 剪；
           ② 上界：need > 剩余未定格数 free（雷放不满）→ 剪。只防负不防欠/防欠不防溢
              都会让搜索树在中期局面爆炸（中高级「无提示」的根因，2026-10-19 二版修）。
           叶端（need 全 0）按各格取值累计「可为雷/可为空」次数；
           恒雷（openCnt=0）/恒空（mineCnt=0）即 100% 确定。
           超预算只作废本分量（宁可少报不卡页面），不拖垮其他分量的提示 */
        const assignArr = new Int8Array(F);
        const dfs = (t: number, need: number[], free: number[]): void => {
          if (overflow) return;
          if (t === F) {
            for (let ci = 0; ci < need.length; ci++) if (need[ci] !== 0) return;
            for (let k = 0; k < F; k++) {
              if (assignArr[k] === 1) mineCnt[k]++;
              else openCnt[k]++;
            }
            return;
          }
          if (++nodes > NODE_CAP) { overflow = true; return; }
          const mineCls = cluesOfVar[t];
          for (const val of [1, 0] as const) {
            let ok = true;
            for (let m = 0; m < mineCls.length; m++) {
              const ci = mineCls[m];
              const nl = need[ci] - val, fl = free[ci] - 1;
              if (nl < 0 || nl > fl) { ok = false; break; }
            }
            if (!ok) continue;
            const need2 = need.slice(), free2 = free.slice();
            for (let m = 0; m < mineCls.length; m++) {
              const ci = mineCls[m];
              need2[ci] -= val; free2[ci] -= 1;
            }
            assignArr[t] = val;
            dfs(t + 1, need2, free2);
          }
        };
        dfs(0, need0.slice(), free0.slice());
        /* 概率 = mineCnt / (mineCnt+openCnt)（分量内条件概率，三期概率提示数据源） */
        for (let t = 0; t < F; t++) {
          if (overflow) break;
          const total = mineCnt[t] + openCnt[t];
          if (total > 0) prob[vlist[t]] = mineCnt[t] / total;
          if (mineCnt[t] > 0 && openCnt[t] === 0) couldMine[vlist[t]] = 1;
          else if (openCnt[t] > 0 && mineCnt[t] === 0) couldSafe[vlist[t]] = 1;
        }
        /* overflow 只影响本分量：不作废全局，继续下一个分量 */
      }
      /* 半径过滤：中心＝鼠标/触点所在格；不在盘上（-1）则不出提示。
         显示只画纯净未开格（state=0）——旗/问号格虽作为未知格参与枚举，
         但玩家已落了自己的标记，再叠雷图/闪烁框只会视觉打架 */
      const resM: number[] = [], resS: number[] = [];
      /* 三期（2026-10-20 张老师定；同日二改：不再要求必雷格已插旗）：
         确定安全格全部已开（无可再打开的格子）即触发黄色提示——把
         雷概率最低的未开前沿格标黄（并列全标：50/50 死猜两格皆黄，
         天然提示「二选一」）。必雷格标没标旗不影响触发（半透明雷提示照常显示）。
         四版（同日）：全图生效——不再按鼠标半径过滤，res* 即全盘结果 */
      const resLow: number[] = [];
      let exhausted = true;
      for (let i = 0; i < n && exhausted; i++) {
        if (couldSafe[i] && state[i] !== 1) exhausted = false;
      }
      for (let i = 0; i < n; i++) {
        if (state[i] !== 0) continue;
        if (couldMine[i]) resM.push(i);
        else if (couldSafe[i]) resS.push(i);
        if (exhausted && prob[i] >= 1e-9) resLow.push(i);
      }
      if (exhausted && resLow.length) {
        let minP = Infinity;
        for (const i of resLow) minP = Math.min(minP, prob[i]);
        for (let k = resLow.length - 1; k >= 0; k--) {
          if (prob[resLow[k]] > minP + 1e-9) resLow.splice(k, 1);
        }
      }
      return { mines: resM, safe: resS, low: resLow };
    }
    /** 提示覆盖层重画（四版：渲染 rookieShown 缓存集合——激活时定格，期间
        新开格由 rookieAction 摘除；不再现场调 rookieHintSet，与鼠标无关） */
    function rookiePaint() {
      const cw = gboard.clientWidth, ch = gboard.clientHeight;
      rookieLayer.setAttribute("viewBox", "0 0 " + cw + " " + ch);
      rookieLayer.setAttribute("preserveAspectRatio", "none");
      const set = rookieShown ?? rookieHintSet();
      let s = "";
      for (const i of set.mines) {
        s += '<use href="#cell-mine" x="' + (i % W) * 16 + '" y="' + ((i / W) | 0) * 16 + '" width="16" height="16" class="op-hint-mine"/>';
      }
      for (const i of set.safe) {
        s += '<rect x="' + ((i % W) * 16 + 0.5) + '" y="' + (((i / W) | 0) * 16 + 0.5) + '" width="15" height="15" rx="2" class="op-hint-safe"/>';
      }
      for (const i of set.low) {
        s += '<rect x="' + ((i % W) * 16 + 0.5) + '" y="' + (((i / W) | 0) * 16 + 0.5) + '" width="15" height="15" rx="2" class="op-hint-low"/>';
      }
      rookieLayer.innerHTML = s;
      rookieLayer.classList.toggle("empty", !s);
    }
    /** 激活提示：建层重画。四版（2026-10-20 张老师定）：全图生效——
        提示内容与鼠标位置无关（画面不随鼠标挪窝跳动/重算）；
        出现后**持续显示**：锚定格子集合进 rookieShown，新开格子不再进入提示
        （直接把新开格从显示中摘掉），直到「本轮所有绿格都已打开」才整层收起；
        纯黄提示（无可开绿格）时无消失条件，持续到局终/重开/关开关 */
    function rookieStart() {
      if (!rookieLayer.parentElement) gboard.appendChild(rookieLayer);
      rookieAnchor = 1;
      const { mines: hm, safe, low } = rookieHintSet();
      rookieShown = { mines: hm.slice(), safe: safe.slice(), low: low.slice() };
      rookiePaint();
    }
    /** 停止提示并清层（lastAct 由调用点决定是否重置） */
    function rookieStop() {
      if (rookieLayer.parentElement) rookieLayer.remove();
      rookieLayer.innerHTML = "";
      rookieAnchor = -1;
      rookieShown = null;
    }
    /** 有效操作信号（toggleFlag 成功插旗 / openCell 开出格时调用）：
        新开的格子从显示集合中摘除（不重算、不重建层——四版「提示期间新开的
        格子不显示提示」）；若本轮绿格（必安全格）已全部打开，整层收起；
        闲置计时保持原语义（从激活时刻重新累计 3 秒后才会再激活） */
    function rookieAction() {
      if (rookieAnchor >= 0 && rookieShown) {
        for (let k = rookieShown.safe.length - 1; k >= 0; k--) {
          if (state[rookieShown.safe[k]] === 1) rookieShown.safe.splice(k, 1);
        }
        for (let k = rookieShown.mines.length - 1; k >= 0; k--) {
          if (state[rookieShown.mines[k]] !== 0) rookieShown.mines.splice(k, 1);
        }
        for (let k = rookieShown.low.length - 1; k >= 0; k--) {
          if (state[rookieShown.low[k]] !== 0) rookieShown.low.splice(k, 1);
        }
        rookiePaint(); // 按剩余集合重画（层不重建、与鼠标无关）
        if (rookieShown.safe.length === 0) rookieStop(); // 本轮绿格全部打开：收起
      }
      rookieLastAct = performance.now();
    }
    /* 唤醒定时器：对局中每 300ms 复查——闲置满 3 秒且未激活即激活。
       四版：激活后不再跟鼠标重算（全图模式，无锚点跟随） */
    rookieTimer = window.setInterval(() => {
      if (!rookieOn || over || !started || replaying) return;
      if (rookieAnchor < 0 && performance.now() - rookieLastAct >= ROOKIE_IDLE_MS) {
        rookieStart();
      }
    }, 300);
    /* 换局时基准确立：rookieLastAct 不在挂载时初始化（performance.now() 在 effect
       内闭包取值即可），开局后第一次唤醒若已闲置 3 秒（如长考后落子前）也会提示——
       符合「卡住」语义 */

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
      /* 回放中重开（F2/切级别/再来一局）：先强制退出回放，清掉光标/拦截标志
         （2026-10-14 张老师报：播放回放后重开不能再玩——回放元素残留锁死游戏）。
         exitReplay 的 repaintAll 在这里跳过：reset 后面自会全盘重画。
         第二个参数 false（七期）：新开一局不许把「本局表现」浮层弹回来 */
      if (replaying) forceExitReplay(false, false);
      const prevLv = lv, prevW = W, prevH = H, prevM = M;
      lv = level || lv;
      const L = levelSize(lv); W = L.x; H = L.y; M = L.m;
      /* 手摆图常驻副本作废条件（2026-10-21 张老师定）：切级别，或自定义规格变了
         （宽/高/雷数任一变化）。笑脸/F2/再来一局等平级 reset 不作废——自定义+
         手摆后只要不切模式/不重新摆雷，点笑脸永远复玩同一张图 */
      if ((level && level !== prevLv) || prevW !== W || prevH !== H || prevM !== M) manualStoredMines = null;
      /* 手动摆雷状态随新局清零（2026-10-21）：manualMode/manualBoard/manualMines
         全部重置；指示器与按钮态收尾（stopManualMode 幂等，非摆雷时只收 UI） */
      manualMode = false;
      manualBoard = false;
      manualMines = new Uint8Array(W * H);
      manualPlaced = 0;
      stopManualMode();
      mines = null; nums = null; state = new Uint8Array(W * H);
      started = false; over = false; openedSafe = 0; totalSafe = W * H - M; board3bv = 0;
      /* 手势状态清零 + 隐藏结算报告（张老师：游戏再次开始时隐藏）；事件流同步清空
         （五期）；重玩锁定标记保留——placeMines 在首击时消费它 */
      leftDown = rightDown = chordDone = false;
      comboGraceT0 = 0; // 连击开局保护窗随新局重置（首格开出时由 startTimer 重启）
      evStream = [];
      /* 原地复活状态随新局作废（2026-10-19）：死亡快照/手势快照/复活计数不跨局 */
      dieSnap = null;
      gestureSnap = null;
      revives = 0;
      /* 新手提示随新局重置：清提示层 + 闲置计时归零（开局起重新等 3 秒）；
         指针记账保留（鼠标可能还停在盘上，首击后即可为提示定位） */
      rookieStop();
      rookieLastAct = performance.now();
      if (pendingLoseBeacon !== null) { clearTimeout(pendingLoseBeacon); pendingLoseBeacon = null; }
      /* 数据面板（八期）：任何时刻都不因开局而显示——只有游戏结束且开关开着才弹出
         （见 report）。statsReport 只读 state/统计量、不读 snapshot，
         故与下面 snapshot = null 的先后无依赖 */
      greport.classList.remove("show");
      gresult.classList.remove("show");
      hideResultModal(); // 结算浮层（七期移动端 / 二版桌面遮罩）随新局一并收起
      snapshot = null;
      stopTimer();
      led(ledMines, M); led(ledTime, 0);
      setFace("smile");
      ngRedeals = 0;
      ngSaves = 0;
      /* 同盘面重开（F2/R）不重建任何 DOM——重建会造成页面跳动（2026-10-14 张老师报），
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
         级别没变（同级别重开）不动它——outerHTML 重建会丢焦点且白排一版 */
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
      /* 开局 tips（2026-10-19 张老师定）：每局一条随机出（showTip 内部自判
         开关，关闭则本局静默） */
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
        /* 二版起必须重算：数据面板撤下后，只剩结算面板的遮罩态可能该回侧边了 */
        syncReportZoom();
        return;
      }
      if (over && lastReportHtml) paintStatPanel(lastReportHtml);
    });
    /* 「开局提示」开关：只管开局技巧气泡（showTip），不影响局中通知气泡（showToast）；
       切换不重开当前局 */
    on(swTips, "change", () => { tipsOn = swTips.checked; saveSettings(); });
    /* 「新手提示」开关：对局中即时生效——关掉立即撤提示层；打开不立刻出
       （须闲置满 3 秒才激活，唤醒定时器会接手）。切换不重开当前局、不动闲置计时 */
    const swRookie = $("sw_rookie") as HTMLInputElement;
    on(swRookie, "change", () => {
      rookieOn = swRookie.checked;
      saveSettings();
      if (!rookieOn) rookieStop();
    });
    /* 「允许复活」开关：即时生效、不重开当前局。败局结算面板正挂着时立即重画
       一次（renderResultPanel 复用定格 snapshot、reviveOn 参与按钮渲染条件）——
       关→按钮当场消失、开→补出按钮（dieSnap 仍在，随时可复活）。用户点遮罩
       关掉过的（maskOpen=false），重画后不强弹回（renderResultPanel 会置
       maskOpen=true，这里补一次 hideResultModal 恢复「关」态） */
    const swRevive = $("sw_revive") as HTMLInputElement;
    on(swRevive, "change", () => {
      reviveOn = swRevive.checked;
      saveSettings();
      if (over && snapshot && !snapshot.won && gresult.classList.contains("show")) {
        const keepClosed = !maskOpen;
        renderResultPanel();
        if (keepClosed) hideResultModal();
      }
    });
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
      /* 开局保护窗按「是否已开局」定（2026-10-22 改开局即生效后重定）：
         未开局（含未首击）→ 窗待命（开局后首格起 1 秒内冻结自动开格）；
         对局中途才开连击 → 首击早已发生且开局已远超 1 秒，comboShield
         自然为假，无需任何放行处理 */
      if (combo && started) comboGraceT0 = 0;
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
      /* 结算浮层跟着全屏宿主走（2026-10-19 二版）：全屏态浏览器只渲染
         fullscreenElement 子树，挂在 body 直下的浮层会整体不可见——而桌面遮罩态
         恰恰只在全屏拉满时才触发，这条是命门。退出全屏搬回 body（避开 #page 的整页 zoom） */
      const fsHost =
        document.fullscreenElement instanceof HTMLElement
          ? document.fullscreenElement
          : document.body;
      if (grModal.parentElement !== fsHost) {
        fsHost.appendChild(grModal);
        window.setTimeout(() => { if (panelSlot === "mask") fitMaskCard(); }, 0);
      }
      if (entered) {
        zoomBeforeFs = zoomCur;
        // 等全屏渲染稳定（innerWidth 更新为屏幕尺寸）后再测量计算
        window.setTimeout(() => { if (document.fullscreenElement === root) fitZoomForFullscreen(); }, 80);
      } else {
        if (zoomBeforeFs !== null) {
          applyZoom(zoomBeforeFs, false);
          zoomBeforeFs = null;
        } else {
          /* 全屏里手动调过比例（zoomDragInput/onWheelZoom 已置 null）：不再原样
             恢复，但也不能把全屏专用的高倍率原封带到窗口模式——小窗口滞留 2.5x
             时右侧结算面板跟着 zoomCur 放大到突兀（2026-10-21 张老师报
             「小窗口玩几把右框变大」根因）。判据与滚轮路径同源（张老师 2026-10-15
             定「无论如何不应该让页面出现滚动条」：溢出比参照态大即收）。⚠️ 基线
             不能就地量——当前已滞留高倍率、溢出已进基线，「不比基线大」恒成立；
             先临时回默认倍率（cus=1x / 标准=1.71x，即 localStorage 被污染前的
             兜底初值）量一份干净参照，再从当前值逐档回收到不超参照为止 */
          applyZoom(zoomCur, false); // 先按 normalMaxZoom 封一道（宽度方向等）
          const zRef = zoomCur;
          applyZoom(lv === "cus" ? 1 : defaultZoom(), false);
          const refOv = flowOverflowPx();
          applyZoom(zRef, false);
          let ov = flowOverflowPx();
          while ((ov.y > refOv.y + 2 || ov.x > refOv.x + 2) && zoomCur > 0.51) {
            applyZoom(+(zoomCur - 0.1).toFixed(2), false);
            ov = flowOverflowPx();
          }
          /* 收档结果落盘：全屏里滚轮/滑杆已把高倍率写进 localStorage，不写回的话
             刷新页面又回到全屏级高倍率、bug 复发。无需收档时写回同值也无害 */
          zoomWant = zoomCur;
          zoomDragEnd();
        }
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
      /* 数据面板常驻时（六期）：跟随 gwrap 重新贴合；二版起这里同时负责
         「<120px 转遮罩 / 空间恢复回侧边」的重新判定（内部对未显示的面板直接早退） */
      syncReportZoom();
      /* 断点跨越（七期）：宽屏 ↔ 窄屏互切后，已结束那局的结算面板搬到对应宿主
         （桌面侧边浮窗 / 遮罩卡片）——否则窄屏下面板会留在看不见的 gresult 里 */
      if (snapshot && mqPanelDesktop.matches !== panelOnDesktop) {
        panelOnDesktop = mqPanelDesktop.matches;
        renderResultPanel();
      }
      positionCusDialog(); // 窗口尺寸/换行变化后重新对准「自定义」tab（未开窗时内部直接跳过）
    }, { signal });

    /* 笑脸＝重新开始（2026-10-21 张老师定）：重新随机布局开新局；
       唯一例外＝自定义+有手摆图（manualStoredMines，首击定格时存常驻副本）——
       点笑脸永远复玩同一张手摆图（锁定盘注入，可无限次；副本只在切级别/
       改规格/重新摆雷时作废，见 reset 与 startManualMode）。
       摆雷期未开局＝普通重开（清掉已摆雷位）；回放中点笑脸＝退出回放
       （reset 自带 forceExitReplay），有手摆图则复玩手摆图 */
    const faceBtn = $("face_btn");
    on(faceBtn, "click", () => {
      if (lv === "cus" && manualStoredMines) {
        pendingBoard = manualStoredMines.slice();
        replayBoardLocked = true;
        reset();
        /* 复玩局延续手摆局口径（manualBoard=true）：无猜不救回——若放任无猜
           重排，玩着玩着盘面就被改写（张老师 21:37 报「踩雷后点笑脸有概率
           重置地图」的真因：复玩局里无猜救回把手摆图悄悄换了）；manualBoard
           也让本局终局快照带 manual 标记，R 链路延续同口径 */
        manualBoard = true;
      } else reset();
    });
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
      /* 手动摆雷模式（2026-10-21）：左键摆雷 / 右键取消（画实雷图标），不录事件流
         （摆雷发生在计时器启动前，事件流 t=0 起步，混入会毁掉回放/录像口径）；
         摆满 M 颗后左键放行＝正常开局手势（首击在 openCell 消费手摆雷区）。
         右键语义：点中手摆雷＝取消（可再补摆）；点空格＝无动作吞掉（摆雷期
         插旗会污染 state）。⚠️ 双键手势第二键（leftDown 已按）不取消——摆满后
         双键 chord 开局，右键落点恰在雷上会误撤雷导致开局哑火。
         拖动（2026-10-21 张老师补）：按住左键滑过＝连续摆雷、按住右键滑过＝
         连续撤雷——mousedown 起手势（manualDrag），mouseover 逐格 toggle，
         window mouseup 收尾 */
      if (manualMode && !started) {
        const full = manualPlaced >= M;
        if (e.button === 2) {
          e.preventDefault();
          if (!leftDown) {
            if (manualMines[i]) manualToggle(i, false);
            manualDrag = -1; // 按住右键滑动＝连续撤雷
          }
          return;
        }
        if (e.button === 0) {
          if (!full) { manualToggle(i, true); manualDrag = 1; return; } // 按住左键滑动＝连续摆雷
          if (manualMines[i]) return; // 落点仍是雷（摆满后右键取消的最后一颗没补）：点了算走位，等补满
          /* 已摆满：本次手势转正常开局，跌出摆雷（manualMode 收尾=首击 openCell 内定格） */
        } else return;
      }      /* 原地复活：新点击手势起点拍快照（踩雷时升格为死亡快照，见 openCell） */
      snapGesture(i);
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
      /* 摆雷拖动（2026-10-21 张老师补）：按住左键滑过＝连续摆、按住右键滑过＝连续撤。
         manualToggle 幂等（摆已摆/撤未撤零动作），来回滑不重复计数；
         摆满后左键手势已转开局（manualDrag=0），不会进本分支。
         空手（buttons=0）划回＝松开发生在窗口外、window mouseup 没收到——
         手势早已结束，先自愈再走常规分支 */
      if (manualDrag && manualMode && !started) {
        if (e.buttons === 0) { manualDrag = 0; }
        else {
          const mi = eventCell(e);
          if (mi >= 0) manualToggle(mi, manualDrag > 0);
          return;
        }
      }
      /* 手势残留自愈：松开发生在浏览器窗口外时 window mouseup 捕不到，
         空手（buttons=0）划回棋盘说明手势早已结束 */
      if (e.buttons === 0 && (leftDown || rightDown)) { leftDown = rightDown = chordDone = false; }
      const i = eventCell(e); if (i < 0) return;
      /* 连击模式滑动连点（2026-10-19 张老师定）：按住左键（含双键同按）滑过未开格
         即开、只按右键滑过未开格即插旗——comboLeftClick/comboRightClick 内部按
         state 守卫，「一格限一次」天然成立（触发过 state 变更即不会再中）；
         无需按下态高亮（动作瞬时完成） */
      if (combo) {
        /* 开局保护（2026-10-22 时间窗版）：窗内的冻结收在 comboLeftClick/
           comboRightClick 内部（无事件零动作），滑动分支只管分发 */
        if (leftDown) { setFace("ooh"); comboLeftClick(i, true); }
        else if (rightDown) { setFace("ooh"); comboRightClick(i, true); }
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
      manualDrag = 0; // 摆雷拖动手势收尾（先于 leftDown 早退——摆雷路径不置 leftDown/rightDown）
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
        /* 开局保护随松开即刻终止（2026-10-22 张老师四定）：开局的那次按住
           手势结束（松开任一键，本就覆盖「松开左键」）＝保护停。后续手势的
           滑动全按真实排雷（雷格照常触发）；对局中途无窗可言（guard 已 0） */
        comboGraceT0 = 0;
        clearPress(); setFace("smile");
        leftDown = rightDown = chordDone = false; return;
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
    let touchManual = false; // 摆雷手势标记（2026-10-21）：本次触点走摆雷 toggle 分支
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
      else if (state[i] === 0) {
        /* 开局保护窗内跳雷（2026-10-22 二定，与桌面 comboLeftClick 同口径；
           时长三定＝初级 0/其余 500ms）：安全格照常开，仅有雷格被跳过（无事件零动作） */
        if (comboShield() && mines && mines[i]) return;
        recordEv(3, i); recordEv(5, i); openCell(i);
      }
    }
    on(gboard, "touchend", (e: TouchEvent) => {
      if (touchTimer) clearTimeout(touchTimer);
      /* 摆雷手势（2026-10-21）：toggle 已在 120ms 定时器触发（或滑动取消），
         收尾只复位，不落常规点按/长按分支。摆满后穿透开局的触点不带此标记、
         走下方常规流程（openCell 消费手摆雷区） */
      if (touchManual) {
        touchManual = false;
        touchCell = -1;
        touchMoved = false;
        if (e.cancelable) e.preventDefault();
        return;
      }
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
      /* 开局保护随抬起即刻终止（2026-10-22 张老师四定，与桌面 mouseup 同口径）：
       * 开局的那次按住手势结束＝保护停，后续手势全按真实排雷 */
      comboGraceT0 = 0;
      e.preventDefault();
    }, { passive: false });
    /* 滑动取消带 12px 容差：手指微颤（1-2px）不再吞掉点按——「有时点击无效」
       的主因就是原实现 touchmove 一动即取消（2026-10-14 张老师报） */
    on(gboard, "touchmove", (e: TouchEvent) => {
      if (touchCell < 0) return;
      const t = e.changedTouches[0];
      if (!t) return;
      /* 摆雷中滑动＝取消点按（与常规点按同容差），防手指微颤误摆 */
      if (touchManual && touchTimer) {
        if (Math.hypot(t.clientX - touchX, t.clientY - touchY) > 12) {
          clearTimeout(touchTimer); touchTimer = null; touchManual = false; touchCell = -1;
        }
        return;
      }
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
        /* 起始格补开（触点不即开，滑动一开始在此补开；首击入口 comboShield
           为假照常开）＋沿轨迹插值逐格开——开局 1 秒保护窗内的冻结收在
           comboTouchOpen 内部（无事件零动作），不再有手势级闸门（2026-10-22） */
        if (state[touchCell] === 0) comboTouchOpen(touchCell);
        {
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
        }
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
      /* 手动摆雷模式（2026-10-21）：触屏无右键，点按＝toggle 摆雷/取消。
         不走长按（长按语义是插旗，与摆雷冲突）；滑动（touchmove 超容差）
         touchCell 会被清 -1，touchend 自然跳过 toggle */
      if (manualMode && !started) {
        touchCell = i;
        touchX = t.clientX; touchY = t.clientY;
        touchMoved = false;
        const full = manualPlaced >= M;
        if (!full || manualMines[i]) {
          touchManual = true; // 摆雷手势：touchend 走摆雷收尾分支
          touchTimer = window.setTimeout(() => {
            /* 点按 toggle：摆满前点未摆格＝摆；摆满后点已摆格＝取消（可再补摆） */
            manualToggle(i, !manualMines[i] && manualPlaced < M);
            if (navigator.vibrate) navigator.vibrate(15);
          }, 120);
          e.preventDefault();
          return;
        }
        /* 已摆满且点的是空格：放行为正常开局手势（下落常规流程，openCell 消费手摆雷区） */
      }
      /* 原地复活：触点手势起点拍快照（点按/滑动连开/长按插旗共用一个起点） */
      snapGesture(i);
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
       缩放/窄屏断点下都成立。全屏/横屏由 fitZoom* 拉满（max=5，仅 fsAutoFit 路径；
       PC 全屏手动上限 FS_ZOOM_CAP），不走此封顶。
       （v8：#page 版式恒定，标准级别与 cus 统一按当前容器封顶——v7 时代 cus
       「宽度按视口/扩版上限算、不按容器」的前提是页宽跟着盘面走，已废）
       cus 额外加高度封顶：常规三级盘高度有限（≤16 行）从不需要，自定义最高
       99 行会被视口下方内容推出去——按「视口底到游戏区顶的可用高」反算倍率，
       与宽度方向取小，保证整个盘面完整可见不裁切 */
    function normalMaxZoom() {
      if (document.fullscreenElement === root) {
        /* fsAutoFit 拉满场景（移动端/横屏/超大 cus 盘）维持 5：页级 zoom 0.65 的
           补偿倍率与「铺满」语义都需要 3x+，封 2.4 会把拉满值直接砸下来；
           PC 标准级别全屏手动调比例才封 FS_ZOOM_CAP（fsAutoFit 为函数声明已提升，
           且全屏分支只可能在挂载完成后被事件回调触达，mqNarrow 无 TDZ 风险） */
        return fsAutoFit() ? 5 : FS_ZOOM_CAP;
      }
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
    /* ---- 面板几何与宿主切换（2026-10-19 二版，张老师两定）---------------------------
       ①「任一显示中的面板侧边渲染宽 < 120px」→ 收起侧板、改遮罩居中显示。
          （上一版 gr_cover「宁盖不缩」被实测否决：全屏高级最大比例下侧空只剩 200px
          上下，196px 的结算面板连雷达带四按钮根本看不清——病根是「地方太小」，
          那就换地方，不是硬塞。）
       ②遮罩态卡片按视口可用宽高整体放大（fitMaskCard），尽量吃满屏幕。
       侧边态 z 口径沿用旧版（跟游戏倍率走 + 侧空/视口高封顶）；自然尺寸量取仍是
       「zoom 归 1 量 rect ÷ 页级 zoom」（十期口径，全引擎一致）。 */
    const PANEL_MIN_W = 120; // 渲染宽下限（屏幕 px）：低于它＝看不清 → 转遮罩
    /* 面板当前住哪：side＝#game_area 左右浮窗；mask＝#gr_modal 卡片（双栏/单列） */
    let panelSlot: "side" | "mask" = "side";
    /* 遮罩此刻是否展开：点遮罩关掉后，即便空间依旧不够也不自动弹回来；
       新一局结算 / 回放结束再弹才置真（见 renderResultPanel / showResultModal） */
    let maskOpen = false;
    /* 全屏遮罩延时弹出（2026-10-20 张老师定）：新结算在全屏+遮罩态下延时 500ms
       再显示——立即盖住棋盘太突兀，「连在哪死的都还没看清楚」。null＝无延时在途。
       调度点在 buildResultPanel 尾部（仅新结算），enterMask 感知本态防 resize 提前弹 */
    let maskDelayTimer: number | null = null;
    /* 结算代际（2026-10-20 延时弹出用）：buildResultPanel 每次新结算 +1——
       延时回调核对自己还是「当前这局」，连续快开新局时旧定时器不越权弹旧结算 */
    let maskDelaySeq = 0;
    /* 侧边宿主下 zoom=1 量的自然尺寸（布局 px）：遮罩态里面板宽由卡片给（width:100%），
       量不出自然宽，所以「回侧边还够不够」只能靠这份缓存反推 */
    const panelBase = { statsW: 0, statsH: 0, resultW: 0, resultH: 0, valid: false };
    /* 雷达挂载回调（2026-10-21 方案 B 配套）：雷达落地（含以后任何重挂）后补一发
       面板几何——治「量高度时雷达还没渲染出来」的时序竞争残余路径 */
    function radarMounted() {
      if (!gresult.classList.contains("show")) return;
      syncReportZoom();
    }

    /* 自然尺寸（zoom 归 1 再量，÷ 页级 zoom 回布局 px）；返回 0 宽＝量不出
       （display:none / 正在搬家） */
    function panelNatural(panel: HTMLElement, pz: number): { w: number; h: number } {
      panel.style.zoom = "1";
      const r = panel.getBoundingClientRect();
      return { w: r.width / pz, h: r.height / pz };
    }
    /* 侧边态目标 zoom 与渲染宽（纯计算，不碰 DOM）：
       自然形态＝跟游戏倍率走，>1.5 时不得高于游戏窗高（十一期：面板顶与银框顶对齐、
       等高即底边齐平）；再按侧空（视口缘 12 + 面板间隙 14）与视口高封顶；
       maxRenderedH＝可选的渲染高上限（布局 px）——结算面板用数据面板的渲染高封顶
       （2026-10-19 张老师定「任何时候结算面板高度都不应超过数据统计面板」：两面板
       顶端对齐，压到等高即底边也齐平。这里是初算值；placeSide 落位后若数据面板被
       底部兜底收缩过，落位处会用最终 zoom 再钳一次） */
    function sideFit(
      base: { w: number; h: number },
      side: "left" | "right",
      gwR: DOMRect,
      pz: number,
      maxRenderedH?: number
    ): { z: number; renderedW: number } {
      const gameCapH = zoomCur > 1.5 && gwR.height > 1 ? gwR.height / (base.h * pz) : 2.5;
      const naturalZ = Math.max(0.3, Math.min(zoomCur, gameCapH, 2.5));
      const availSide =
        side === "left" ? gwR.left - 12 - 14 : window.innerWidth - gwR.right - 12 - 14;
      const sideCap = base.w > 1 ? availSide / (base.w * pz) : 2.5;
      const hCap = base.h > 1 ? (window.innerHeight - gwR.top - 12) / (base.h * pz) : 2.5;
      const hStats =
        maxRenderedH != null && base.h > 1 ? maxRenderedH / (base.h * pz) : 2.5;
      const z = Math.max(0.25, Math.min(naturalZ, sideCap, hCap, hStats));
      return { z, renderedW: base.w * z * pz };
    }
    /* 侧边定位（公式＝旧版逐字，生产多轮验证）：left 面板右缘贴「银框左−14」、
       right 面板左缘贴「银框右+14」，顶端与银框顶对齐；视口坐标 → game_area 局部
       坐标（再 ÷页级 zoom ÷ 自身 zoom）。设后实测闭环：底部越出视口就按高度比
       再压一档（面板高 ∝ zoom 线性） */
    function placeSide(
      panel: HTMLElement,
      side: "left" | "right",
      base: { w: number; h: number },
      z: number,
      gwR: DOMRect,
      gaR: DOMRect,
      pz: number
    ): number {
      const put = (zz: number) => {
        const t = (v: number) => v / pz / zz;
        panel.style.zoom = String(zz);
        panel.style.top = t(gwR.top - gaR.top) + "px";
        panel.style.left =
          side === "left"
            ? t(gwR.left - gaR.left - 14) - base.w + "px"
            : t(gwR.right - gaR.left + 14) + "px";
      };
      put(z);
      const now = panel.getBoundingClientRect();
      let zFinal = z;
      if (now.bottom > window.innerHeight - 8 && now.height > 1) {
        zFinal = Math.max(0.25, z * ((window.innerHeight - 8 - now.top) / now.height));
        put(zFinal);
      }
      return zFinal; // 实际生效 zoom（末段兜底收缩后可能 < 入参；结算封顶要用它）
    }
    /* 面板搬家：只挪节点、不重建（雷达 React root、按钮事件绑定都留在原位）。
       进遮罩清掉侧边态的 inline 定位与缩放——卡片统一缩放，面板不再自理 */
    function mountPanels(slot: "side" | "mask") {
      if (slot === "mask") {
        if (gresult.parentElement !== grmResult) grmResult.appendChild(gresult);
        if (greport.parentElement !== grmStats) grmStats.appendChild(greport);
        for (const p of [greport, gresult]) {
          p.style.left = "";
          p.style.top = "";
          p.style.zoom = "";
        }
      } else {
        if (gresult.parentElement !== gameAreaEl) gameAreaEl.appendChild(gresult);
        if (greport.parentElement !== gameAreaEl) gameAreaEl.appendChild(greport);
        /* 搬回侧边：清掉遮罩态钳过的雷达宽（侧边态自有一套几何，重新判定） */
        const radarWrap = gresult.querySelector<HTMLElement>(".vr_wrap");
        if (radarWrap) radarWrap.style.maxWidth = "";
      }
      panelSlot = slot;
    }
    /* 遮罩卡片整体缩放（张老师定「遮罩态结算面板的比例应尽可能利用屏幕空间」）：
       zoom 归 1 量卡片自然尺寸 → 按视口可用宽高等比放大（#gr_modal padding 16×2），
       封顶 2.5（与侧边自然上限同档，再大就成放大镜）、保底 0.5（两栏并排的窄屏兜底）。
       **结算面板高度封顶（2026-10-19 三期「任何时候」）**：卡片比侧边宽 → 雷达
       fill 高度∝宽度涨，结算面板常反超数据面板（竖屏实测 461 vs 343）。给面板整体
       zoom 压不住——雷达 SVG 是 width:100%，按宿主**布局宽**自适应，面板缩放后
       布局宽没变，雷达反而按新渲染宽回涨。正解＝直接钳雷达宽：雷达是面板里唯一
       弹性高度、且高≡宽（正方形 viewBox），把渲染宽压掉超出量、高度 1:1 回落，
       百分比 max-width 相对宿主取值、免算页级缩放 */
    function fitMaskCard() {
      if (panelSlot !== "mask" || grModal.hidden) return;
      /* 清上一轮钳宽：卡片先按未压自然尺寸适配。钳宽落点＝.vr_wrap（2026-10-20
         张老师定「雷达图任何时候居中」）：钳 svg 时块级 svg 默认靠左；挂在 wrap 上
         由 .gr_radar 的 flex justify-content:center 自动居中，且 svg 恒填满 wrap、
         气泡「与 wrap 等宽同起点」的定位假设保持成立 */
      const radarWrap = gresult.querySelector<HTMLElement>(".vr_wrap");
      if (radarWrap) radarWrap.style.maxWidth = "";
      grmCard.style.zoom = "1";
      const r = grmCard.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const z = Math.max(
        0.5,
        Math.min(2.5, (window.innerWidth - 32) / r.width, (window.innerHeight - 32) / r.height)
      );
      grmCard.style.zoom = String(z);
      if (greport.classList.contains("show") && radarWrap) {
        /* 迭代收敛（同侧边态闭环复核）：目标＝数据面板实际渲染高；单次钳宽受
           布局量化影响可能差零点几像素，迭代「量→压→再量」至多 3 轮 */
        const target = greport.getBoundingClientRect().height;
        if (target > 1) {
          for (let i = 0; i < 3; i++) {
            const h = gresult.getBoundingClientRect().height;
            if (h <= target + 0.5) break;
            const rw = radarWrap.getBoundingClientRect().width;
            if (rw <= 100) break;
            const over = h - target - 0.5;
            const cur = radarWrap.style.maxWidth ? parseFloat(radarWrap.style.maxWidth) / 100 : 1;
            const next = Math.max(100 / rw, (rw - over) / rw) * cur;
            radarWrap.style.maxWidth = (next * 100).toFixed(3) + "%";
          }
        }
      }
    }
    /* 转遮罩。首次进入（面板还在侧边）自动展开——空间被挤爆是被迫换地方，
       玩家需要看到结算；已住在卡片里则沿用 maskOpen（点遮罩关掉就别自己弹回）。
       延时窗口内（maskDelayTimer 挂着）不提前展开——500ms 的「看清死在哪」
       缓冲由定时器收口，resize 触发的重判别把缓冲吃掉 */
    function enterMask() {
      if (panelSlot !== "mask") {
        mountPanels("mask");
        maskOpen = true;
      }
      if (maskDelayTimer !== null) return;
      grModal.hidden = !maskOpen;
      if (maskOpen) fitMaskCard();
    }
    function syncReportZoom() {
      const wantStats = greport.classList.contains("show");
      const wantResult = gresult.classList.contains("show");
      if (!wantStats && !wantResult) {
        grModal.hidden = true;
        return;
      }
      /* 窄屏（<960）CSS 里没有侧边位（.greport.show/.gresult.show 只在 ≥960 生效），
         恒走遮罩卡片：竖屏单列（数据面板在结算面板下面）、横屏双栏（数据在左），
         排版见 globals.css 的 #gr_modal 块 */
      if (!mqPanelDesktop.matches) {
        enterMask();
        return;
      }
      const pz = pageZoom();
      const gwR = gwrap.getBoundingClientRect();
      const gaR = gameAreaEl.getBoundingClientRect();
      /* 自然尺寸只能在侧边宿主量得出：缓存为空、或某个要显示的面板还没量过
         （先在窄屏显示、再转宽屏）时，先搬回侧边量一次，之后一路靠缓存判断 */
      const needMeasure =
        panelSlot === "mask" &&
        (!panelBase.valid ||
          (wantStats && panelBase.statsW < 1) ||
          (wantResult && panelBase.resultW < 1));
      if (needMeasure) mountPanels("side");
      if (panelSlot === "side") {
        /* 量取前清上一轮的雷达钳宽（2026-10-19 三期）：钳过的自然高是假自然高，
           panelBase 缓存一旦吃进污染值，后续所有 fit 判定全偏 */
        const radarWrapM = gresult.querySelector<HTMLElement>(".vr_wrap");
        if (radarWrapM) radarWrapM.style.maxWidth = "";
        if (wantStats) {
          const b = panelNatural(greport, pz);
          panelBase.statsW = b.w;
          panelBase.statsH = b.h;
        }
        if (wantResult) {
          /* 防污染闸（2026-10-21 张老师报「初级结算面板反复横跳」根因，方案 B）：
             雷达未挂上（.vr_wrap 不存在）时结算面板正处在「无雷达」假形态，此刻量出的
             高度比真实矮 ~170px——绝不能写进 panelBase 缓存，否则所有高度封顶失守、
             雷达落地后面板暴涨。跳过本面板一次测量，沿用缓存值；缓存也没有时（首次）
             由 flushSync（方案 A）保证雷达先落地，正常不会走到这条路 */
          if (!gresult.querySelector(".vr_wrap")) return;
          const b = panelNatural(gresult, pz);
          panelBase.resultW = b.w;
          panelBase.resultH = b.h;
        }
        panelBase.valid = panelBase.statsW > 1 || panelBase.resultW > 1;
      }
      const statsFit = wantStats
        ? sideFit({ w: panelBase.statsW, h: panelBase.statsH }, "left", gwR, pz)
        : null;
      /* 结算面板渲染高封顶＝数据面板渲染高（张老师 2026-10-19 定，见 sideFit 注释）；
         数据面板没显示（统计开关关）则不设限。渲染高＝自然高 × z × pz（屏幕 px） */
      const resultMaxH =
        statsFit && panelBase.statsH > 1 ? statsFit.z * panelBase.statsH * pz : undefined;
      const resultFit = wantResult
        ? sideFit(
            { w: panelBase.resultW, h: panelBase.resultH },
            "right",
            gwR,
            pz,
            resultMaxH
          )
        : null;
      /* 阈值判定：任一面板按侧边公式摆出来都不到 120px 渲染宽 → 侧边没有意义，转遮罩 */
      if (
        (statsFit && statsFit.renderedW < PANEL_MIN_W) ||
        (resultFit && resultFit.renderedW < PANEL_MIN_W)
      ) {
        enterMask();
        return;
      }
      /* 全屏专属判定（2026-10-19 张老师定）：全屏里侧空被棋盘吃干后，结算面板会被
         压到不比数据面板宽——主次颠倒、雷达也糊成一团，此时就该换成遮罩居中显示。
         （自然宽度下结算 ~204 > 数据 ~127，天然不会触发；只有被侧空 / 结算高封顶
         压过才可能，即「真的被挤扁了」才换地方。+0.5 容差把「恰好相等」也算进来） */
      if (
        document.fullscreenElement === root &&
        statsFit &&
        resultFit &&
        resultFit.renderedW <= statsFit.renderedW + 0.5
      ) {
        enterMask();
        return;
      }
      /* 放得下：回侧边宿主（空间恢复＝自动切回，不用玩家操作），遮罩收起。
         结算高封顶用数据面板**最终落位 zoom**算（2026-10-19 三期）：placeSide 末段
         有「底边越视口」兜底收缩，数据面板被压过的话，先摆它、拿实际生效 zoom
         再算结算封顶——否则封顶偏松，极端窄高视口下结算仍可能超过数据面板 */
      mountPanels("side");
      grModal.hidden = true;
      let statsZFinal: number | null = null;
      if (statsFit) {
        statsZFinal = placeSide(greport, "left", { w: panelBase.statsW, h: panelBase.statsH }, statsFit.z, gwR, gaR, pz);
      }
      if (resultFit) {
        const capH = statsZFinal != null ? statsZFinal * panelBase.statsH * pz : resultMaxH;
        const zCap = capH != null && panelBase.resultH > 1 ? capH / (panelBase.resultH * pz) : 2.5;
        const zRes = Math.max(0.25, Math.min(resultFit.z, zCap));
        placeSide(gresult, "right", { w: panelBase.resultW, h: panelBase.resultH }, zRes, gwR, gaR, pz);
        /* 闭环复核 + 迭代收敛（2026-10-19 三期）：zoom 舍入与 maxWidth 的布局量化
           （Chrome 1/64px）让单次开环钳宽常差零点几像素——迭代「量→压→再量」
           至多 3 轮收敛；目标直接用数据面板**实际渲染高**（消除计算值 ε）。
           与 fitMaskCard 同一手法（那边超出量大、单发即中，这里超出量小才需要迭代） */
        if (statsZFinal != null) {
          const target = greport.getBoundingClientRect().height;
          const radarWrap = gresult.querySelector<HTMLElement>(".vr_wrap");
          if (radarWrap && target > 1) {
            for (let i = 0; i < 3; i++) {
              const h = gresult.getBoundingClientRect().height;
              if (h <= target + 0.5) break;
              const rw = radarWrap.getBoundingClientRect().width;
              if (rw <= 100) break; // 雷达保底 100px，不硬压成一条线
              const over = h - target - 0.5;
              const cur = radarWrap.style.maxWidth ? parseFloat(radarWrap.style.maxWidth) / 100 : 1;
              const next = Math.max(100 / rw, (rw - over) / rw) * cur;
              radarWrap.style.maxWidth = (next * 100).toFixed(3) + "%";
            }
          }
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
       归一到布局 px（同 fitZoomForLandscape 口径）。max 5 仅服务 fsAutoFit 拉满路径
       （移动端页级 0.65 会把渲染尺寸缩回去，拉满常需 3+，不进 localStorage）；PC 标准
       级别全屏上限已封 FS_ZOOM_CAP=2.4（2026-10-21 张老师定，拉满路径不受影响）。

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
        /* PC 端：比例不动，只把滑杆行程放宽到全屏口径（normalMaxZoom 全屏恒 FS_ZOOM_CAP，
           玩家在全屏里想手动放大不受普通模式的容器宽限制）。
           ⚠️ 不能无条件走 applyZoom(zoomCur)：cus 大盘 0.3~0.5x 会被 floor 0.5 抬升
           小幅放大（setZoomVisual 才是不动比例的安全路径）。仅当窗口模式已调到
           超 2.4（窗口上限 2.5）时才经 applyZoom 压回全屏上限 */
        const capFs = String(normalMaxZoom());
        zoomRange.max = capFs;
        cusZoom.max = capFs;
        if (zoomCur > FS_ZOOM_CAP) applyZoom(zoomCur, false);
        /* 面板几何必须跟着重算（2026-10-19 二版）：旧版这里直接 return，全屏拉大后
           侧空被压缩、面板却还按进全屏前的尺寸摆着 —— 张老师截图里那两条窄边就是这么来的。
           现在重算一次即可判出「侧边放不下 → 转遮罩」 */
        syncReportZoom();
        requestAnimationFrame(syncReportZoom);
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
      /* 空格＝原地复活（2026-10-19 张老师定）：仅踩雷结算态可触发（over 且有
         死亡快照；胜局/开局/回放中/输入框聚焦一律不劫持）。 revive 内部自带
         over/dieSnap 守卫，这里再拦输入框，避免打字场景误触发 */
      if (e.key === " ") {
        const t0 = e.target as HTMLElement;
        if (t0 && (t0.tagName === "INPUT" || t0.tagName === "TEXTAREA")) return;
        if (replaying) return;
        if (over && dieSnap && !snapshot?.won && reviveOn) {
          e.preventDefault();
          revive();
        }
        return;
      }
      /* F2＝换一张新地图重开（手摆局点笑脸才会复玩地图，F2 恒新图——2026-10-21 张老师定）——
         回放中、自定义弹窗开着、焦点在控件上，都一律重开，不做任何拦截。
         （reset 内部已自带 forceExitReplay，回放中重开是安全的） */
      if (e.key === "F2") {
        e.preventDefault();
        reset();
        return;
      }
      /* 数字键 1/2/3/4 切级别（2026-10-19 张老师定）：1=初级 2=中级 3=高级，
         同级别再按＝刷新重开（与 tab 点击「同级别不动」不同，快捷键恒刷新）；
         4=自定义，≡点「自定义」tab：恒开规格窗、未在自定义时切盘（openCusDialog 内语义）。
         带 Ctrl/Meta/Alt 修饰不拦（不劫持浏览器切标签等快捷键）。
         ⚠️ 必须放在 cus 弹窗/回放守卫之前：①按 4 弹出规格窗后再按 1/2/3 要能切走
         （切走时随手关窗，2026-10-19 张老师实测报障）；②与鼠标点 tab 完全同路——
         tab 点击也不受弹窗/回放拦截（reset 自带 forceExitReplay）。焦点在输入框仍不劫持 */
      if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
        const t = e.target as HTMLElement;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        e.preventDefault();
        if (e.key === "4") openCusDialog();
        else {
          if (cusDlg.classList.contains("open")) closeCusDialog(); // 离开自定义：规格窗随手关
          reset(e.key === "1" ? "beg" : e.key === "2" ? "int" : "exp");
        }
        return;
      }
      /* a/A＝再来一局（2026-10-19 张老师二定改键：A=再来一局、R=重玩本局）。
         与按钮**完全同路**（newGame 显式清锁定盘标记）；对局中与结算态都可触发，
         沿用旧 r/R 的守卫规矩：cus 弹窗开着（输入框里打字）/ 回放中不响应 */
      if (cusDlg.classList.contains("open")) return;
      if (replaying) return;
      const t2 = e.target as HTMLElement;
      if (t2 && (t2.tagName === "INPUT" || t2.tagName === "TEXTAREA")) return;
      if (e.key === "a" || e.key === "A") {
        if (e.ctrlKey || e.metaKey || e.altKey) return; // 不劫持 Ctrl+A 全选
        e.preventDefault();
        newGame();
        return;
      }
      /* r/v/d＝重玩本局 / 查看回放 / 下载录像（与面板按钮同路）。
         仅**结算态**触发（over 且有终局快照——胜/负局都可；对局中按了没结果属误触）。
         复用上面的守卫：cus 弹窗开 / 回放中 / 输入框聚焦都已 return。
         ⚠️ 修饰键不拦会劫持 Cmd+D（收藏）等系统快捷键，必须守 */
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const panelReady = over && !!snapshot;
      if (panelReady && (e.key === "r" || e.key === "R")) { e.preventDefault(); replaySameBoard(); return; }
      if (panelReady && (e.key === "v" || e.key === "V")) { e.preventDefault(); startInPlaceReplay(); return; }
      if (panelReady && (e.key === "d" || e.key === "D")) { e.preventDefault(); downloadAvf(); return; }
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
        /* 手动摆雷测试钩子（2026-10-21）：摆雷进度与开局态 */
        started: () => started,
        manualMode: () => manualMode,
        manualPlaced: () => manualPlaced,
        manualStored: () => (manualStoredMines ? Array.from(manualStoredMines) : null),
        M: () => M,
        combo: () => combo,
        /* 连击开局保护窗剩余毫秒（2026-10-22 时间窗版；时长四定＝初级 0/
           中级 250/高级与自定义 500，开局后松开左键即刻归零）；<=0＝不在窗内 */
        guard: () => (started ? Math.max(0, (lv === "beg" ? 0 : lv === "int" ? 250 : 500) - (performance.now() - comboGraceT0)) : 0),
        over: () => over,
        nf: () => nf,
        ng: () => ng,
        bv3: () => board3bv,
        bvSel: () => ({ ...bvSel[lv] }),
        lv: () => lv,
        ngRedeals: () => ngRedeals,
        /* 原地复活（2026-10-19）：无头测试读死亡快照/复活计数；
           reviveOn＝「允许复活」开关状态（2026-10-20） */
        revives: () => revives,
        reviveOn: () => reviveOn,
        dieSnap: () => (dieSnap ? { hit: dieSnap.hit, evLen: dieSnap.evLen, csec: dieSnap.csec } : null),
        /* 快捷键/锁定盘测试钩子（2026-10-19）：A 键重玩本局的锁定盘注入验证
           （pending 与 mines 同口径 Array.from——裸 Uint8Array 经 CDP 序列化会变形） */
        locked: () => replayBoardLocked,
        pending: () => (pendingBoard ? Array.from(pendingBoard) : null),
        snapMines: () => (snapshot ? Array.from(snapshot.mines) : null),
        /* 统计一致性验证（2026-10-16）：当局事件流 + 共享引擎重算结果 */
        events: () => evStream.slice(),
        /* 新手提示（2026-10-19）测试钩子：开关/指针/锚点/闲置计时 */
        rookie: () => ({ on: rookieOn, active: rookieAnchor >= 0, sinceAct: performance.now() - rookieLastAct }),
        hint: () => rookieHintSet(),
        /* 开局提示候选池（2026-10-20）：无头验证「允许复活」过滤逻辑 */
        tipPool: () => tipPool(),
        counts: () => gameCounts(),
        size: () => ({ w: W, h: H, m: M }),
        /* 拖拽导入（2026-10-21）：最近导入的文件名 + 手动触发入口（无头测试用） */
        imported: () => importedName,
        dropImport: (buf: number[], ext: string) => importDroppedVideo(new Uint8Array(buf), ext),
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
    swRookie.checked = rookieOn;
    swRevive.checked = reviveOn;
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
      dropHint.remove(); // 拖拽导入高亮层随组件卸载一起收走
      /* 结算浮层（七期）挂在 body/全屏宿主上：卸载时先卸雷达 React root 再摘元素。
         面板若正住在卡片里，先搬回 React 自己的宿主（#game_area），
         否则会随 grModal.remove() 一起被摘走、React 卸载时找不到节点 */
      radarRootRef.current?.unmount();
      radarRootRef.current = null;
      if (greport.parentElement === grmStats) gameAreaEl.appendChild(greport);
      if (gresult.parentElement === grmResult) gameAreaEl.appendChild(gresult);
      grModal.remove();
      document.documentElement.classList.remove("op-fakefs"); // 伪全屏态不跨页残留
      document.documentElement.classList.remove("op-noscroll"); // 整页锁滚随本页一起摘掉
      if (timerId) clearInterval(timerId);
      if (touchTimer) clearTimeout(touchTimer);
      if (cusTimer !== null) clearTimeout(cusTimer); // 拖杆节流残留的 trailing 定时器
      if (wheelTimer !== null) clearTimeout(wheelTimer); // 滚轮落盘的 trailing 定时器
      /* 开局 tips 的渐隐定时（卸载时不留残余回调） */
      if (tipFadeTimer !== null) clearTimeout(tipFadeTimer);
      /* 全屏遮罩延时弹出的定时器（同上，卸载即废） */
      if (maskDelayTimer !== null) clearTimeout(maskDelayTimer);
      /* 新手提示：唤醒定时器与覆盖层一并清掉 */
      if (rookieTimer !== null) clearInterval(rookieTimer);
      rookieLayer.remove();
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
          {/* 手动摆雷指示器（2026-10-21 张老师定）：摆雷模式激活时出现在
              「自定义」tab 右侧——「（摆雷中 x/M）」黄字，摆满变绿「（摆雷完成）」 */}
          <span className="manual_badge" id="manual_badge" hidden>（摆雷中）</span>
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
            <span className="tip">连击模式：按下并拖动视为对所有经过格子进行点击</span>
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
          {/* 「开局提示」（2026-10-19 张老师定，默认开）：每次开局随机显示一条技巧气泡；
              关闭后任何开局提示都不出 */}
          <div className="gs_row">
            <span className="gs_name">开局提示</span>
            <label className="gsw"><input type="checkbox" id="sw_tips" /><span className="track" /></label>
            <span className="tip">每次开局显示一条技巧提示，可随时关闭</span>
          </div>
          {/* 「新手提示」（2026-10-19 张老师定，默认关）：闲置 3 秒标出鼠标附近
              100% 可确定的雷（半透明雷）与安全格（闪烁）；hover 文案＝张老师原话 */}
          <div className="gs_row">
            <span className="gs_name">新手提示</span>
            <label className="gsw"><input type="checkbox" id="sw_rookie" /><span className="track" /></label>
            <span className="tip">当卡住时，提示附近能确定的地雷和空</span>
          </div>
          {/* 「允许复活」（2026-10-20 张老师定，默认开）：关闭后踩雷结算不再出现
              复活按钮、空格键也不能复活；hover 文案＝张老师原话 */}
          <div className="gs_row">
            <span className="gs_name">允许复活</span>
            <label className="gsw"><input type="checkbox" id="sw_revive" /><span className="track" /></label>
            <span className="tip">踩雷后允许复活继续</span>
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
          {/* 手动摆雷（2026-10-21 张老师定）：进入摆雷模式——左键摆雷 / 右键取消，
              摆满雷数后才能开局；进行中再点＝放弃并重开随机盘 */}
          <button className="cus_manual_btn" id="btn_manual" type="button">手动摆雷</button>
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
            {/* 笑脸＝重新开始（手摆局＝重玩本局，见 faceBtn click 处注释） */}
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
