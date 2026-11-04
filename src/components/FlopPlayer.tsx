// flop 播放器接入（移植 2008 版 Models/Include/FlopPlayer.asp 的协议）
// 协议：
//   1. 页面嵌入全屏 iframe（初始 flop-player-display-none），src 指向 /play/index.html
//   2. 播放器加载后注入 parent.flop.playVideo(uri, options)，并回调 parent.flop.onload()
//   3. 播放/退出由播放器自己切换 iframe 的 flop-player-display-none 与 body 的
//      flop-player-overflow-hidden（self.frameElement，同源可操作）
//   4. 退出时回调 options.listener

"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    /** 已注入宿主脚本的文档标记（以文档为单位防重入，跨文档不误判） */
    __flopHostedDoc?: Document;
    flop?: {
      playVideo?: (
        uri: string,
        options: {
          anonymous?: boolean;
          background?: string;
          share?: unknown;
          listener?: () => void;
        }
      ) => void;
      onload?: () => void;
      /** 退出播放并复位内部状态（遮罩点击与 X 共用播放器原生退出链路） */
      closeVideo?: () => void;
      /** 播放器未就绪时的待播队列（playFlop 记下，onload 后补播） */
      pendingUri?: string;
    };
  }
}

const PLAY_OPTIONS = {
  // 半透明黑色遮罩（2008 版 PlayVideoParent 同款）：播放器在 iframe 内渲染
  // 全屏遮罩层，宿主页面内容透出变暗；点击遮罩退出见 MASK_EXIT_SCRIPT
  background: "rgba(0, 0, 0, .5)",
  listener: () => {},
} as const;

/** 待播轮询句柄（模块级单例；onload 回调之外的兜底补播通道） */
let pendingPoll: number | undefined;

/** 播放器就绪前 playFlop 的兜底轮询：onload 可能已经放过（晚于点击时不再触发），
    也可能因 window.flop 被本函数先建出来而错过赋值——统一靠轮询补播。 */
function startPendingPoll() {
  if (pendingPoll !== undefined) return;
  pendingPoll = window.setInterval(() => {
    const flop = window.flop;
    if (flop?.playVideo && flop.pendingUri) {
      const uri = flop.pendingUri;
      flop.pendingUri = undefined;
      window.clearInterval(pendingPoll);
      pendingPoll = undefined;
      flop.playVideo(uri, PLAY_OPTIONS);
    }
  }, 120);
  // 15s 兜底停表：播放器始终未就绪（如 iframe 加载失败）就放弃
  window.setTimeout(() => {
    if (pendingPoll !== undefined) {
      window.clearInterval(pendingPoll);
      pendingPoll = undefined;
    }
  }, 15000);
}

/** 播放录像（播放器未就绪时记入待播队列，就绪后自动补播） */
export function playFlop(uri: string) {
  /* ⚠️ window.flop 可能尚未存在——SSR 表格（tbody）出现在 iframe 引导完成之前，
     用户此时点播放，此前「直接 return」会把 URI 静默丢弃（2026-10-28 生产实测：
     就绪前点击 video-file 请求数为 0，播放器永远停在初始菜单）。改为先建对象
     记下 pendingUri，再用 120ms 轮询兜底补播（与 FlopPlayer 的 onload 回调
     双通道都判 pendingUri，先到先播、不会重复起播）。 */
  const flop = (window.flop = window.flop ?? {});
  flop.pendingUri = uri;
  if (flop.playVideo) {
    flop.playVideo(uri, PLAY_OPTIONS);
    flop.pendingUri = undefined;
    return;
  }
  startPendingPoll();
}

/* 注入播放器 iframe 的窄屏适配脚本：
   播放器窗口（统计表 + 游戏窗 + 控制条）按桌面宽度排布（高级 ~582px），
   手机视口装不下会被裁掉。iframe 同源，注入脚本在内容超出视口时把窗口整体
   zoom 缩放到视口宽（SVG 矢量缩放无损），桌面端宽裕时不做任何缩放。
   ⚠️ 2026-11-03 起**不含播放器窗口**（含 .game-menu 的节点跳过）：窗口层
   zoom 唯一 owner 是 ZOOM_SCRIPT.syncWinZoom——本脚本 set/clear 交替与
   ZOOM 争抢同一属性曾致回放期间尺寸持续振荡（详见 fit() 内注释）。 */
const FIT_PLAYER_SCRIPT = `
(function () {
  if (window.__flopFit) return;
  window.__flopFit = true;
  function fit() {
    var vw = document.documentElement.clientWidth;
    if (!document.body || !vw) return;
    // 候选 = body 直接子元素 + 其子元素（Vue 根 div 下的播放器窗口在第二层）
    var els = [];
    for (var i = 0; i < document.body.children.length; i++) {
      var el = document.body.children[i];
      els.push(el);
      for (var j = 0; j < el.children.length; j++) els.push(el.children[j]);
    }
    for (var k = 0; k < els.length; k++) {
      var node = els[k];
      var tag = node.tagName;
      if (tag === "SCRIPT" || tag === "NOSCRIPT" || tag === "STYLE" || tag === "LINK") continue;
      if (node.classList && node.classList.contains("fullscreen")) continue;
      /* ⚠️ 播放器窗口（含 .game-menu 的 root/win 两层）不归本脚本管（2026-11-03
         尺寸跳动事故）：本脚本 set/clear 交替（measure 含 zoom → 缩到刚好放下 →
         下次 mutation 又 clear → 又溢出），与 ZOOM_SCRIPT 的 syncWinZoom 争抢
         同一个 win.style.zoom，回放期间 childList 变更不断触发即持续振荡。
         窗口缩放唯一 owner = ZOOM_SCRIPT（其 syncWinZoom 乘法修正按构造收敛） */
      if (node.querySelector && node.querySelector(".game-menu")) continue;
      var rect = node.getBoundingClientRect();
      var w = Math.max(rect.width, node.scrollWidth);
      if (w > vw + 1) {
        var z = vw / w;
        var cur = parseFloat(node.style.zoom || "1") || 1;
        if (Math.abs(cur - z) > 0.001) node.style.zoom = String(z);
      } else if (node.style.zoom) {
        node.style.zoom = "";
      }
    }
  }
  var raf = 0;
  var schedule = function () {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; fit(); });
  };
  window.addEventListener("resize", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  fit();
})();
`;

/* 注入播放器 iframe 的「游戏区滚轮缩放」脚本（2026-11-03 张老师需求；
   2026-11-04 改口径：打开不再自动 fit 拉满，直接默认 1 倍；
   2026-11-05 改口径：打开/换盘直接是记忆倍率，不许默认尺寸先闪现——
   childList 观察到棋盘（重）出现时在微任务里（绘制前）立刻 apply）：
   滚轮悬停游戏区（棋盘 SVG + 其上的菜单条）→ 整块按 zoom 缩放（SVG 矢量无损，
   zoom 影响布局让窗口自动回流重排，且 FIT_PLAYER_SCRIPT 已证明 zoom 不破坏
   棋盘指针交互）。口径：
   - 数据面板、控制条不随滚轮缩放；
   - 游戏区缩放后高度超过数据面板自然高度时，数据面板 zoom 跟涨到与游戏区等高
     （张老师补充口径：面板「可以随着游戏界面一起缩放」）；
   - 控制条永不缩放；
   - 缩放范围 0.5–3，双击游戏区复位 1；
   - 手动调整（滚轮/双击）后的倍率写入 localStorage（同源 iframe 与站点共享），
     下次打开播放器直接复用；换录像/换级别倍率同样保留（挂在新棋盘的父容器上，
     父容器不随回放重建，轮询在新盘面出现后重挂）。 */
const ZOOM_SCRIPT = `
(function () {
  if (window.__flopZoom) return;
  window.__flopZoom = true;
  var K_MIN = 0.5, K_MAX = 3;
  var LS_KEY = "flopPlayerZoom";
  var lastNatKey = "";   // 上次应用的棋盘自然尺寸（换盘面=尺寸变化→重挂倍率）
  /* 初始倍率＝上次手动调整的持久值（2026-11-04 改口径：打开不再自动 fit 拉满，
     直接用默认/记忆倍率；异常值一律回落 1） */
  function loadK() {
    try {
      var v = parseFloat(localStorage.getItem(LS_KEY));
      if (v >= K_MIN && v <= K_MAX) return v;
    } catch (e) {}
    return 1;
  }
  function saveK() {
    try { localStorage.setItem(LS_KEY, String(k)); } catch (e) {}
  }
  var k = loadK();

  function playerWin() {
    var menu = document.querySelector(".game-menu");
    if (!menu) return null;
    var root = menu;
    while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
    if (root === menu) return null;
    var win = menu;
    while (win.parentElement && win.parentElement !== root) win = win.parentElement;
    return win === menu ? null : win;
  }
  /* 窗口层生效 zoom（FIT_PLAYER_SCRIPT 窄屏适配会 zoom 窗口节点，须计入换算） */
  function winZoom(win) {
    return (win && win.style && parseFloat(win.style.zoom)) || 1;
  }
  /* 棋盘 SVG＝win 内带非零 viewBox 且可见尺寸可观的 svg（defs symbol svg viewBox 为 0 被排除） */
  function findArea() {
    var win = playerWin();
    if (!win) return null;
    var svgs = win.querySelectorAll("svg[viewBox]");
    for (var i = 0; i < svgs.length; i++) {
      var vb = svgs[i].viewBox && svgs[i].viewBox.baseVal;
      if (!vb || vb.width <= 0) continue;
      if (svgs[i].getBoundingClientRect().width > 100) return svgs[i];
    }
    return null;
  }
  /* 游戏区自然尺寸（去除窗口层 zoom 与本区 zoom 后的 1x 布局尺寸） */
  function natOf(svg) {
    var area = svg.parentElement;
    var z = winZoom(playerWin()) * (parseFloat(area.style.zoom) || 1);
    var r = area.getBoundingClientRect();
    return { w: r.width / z, h: r.height / z };
  }
  /* 数据面板＝游戏区容器的父级下「含 table 且非游戏区」的那个子块 */
  function findStats(area) {
    var parent = area.parentElement;
    if (!parent) return null;
    for (var i = 0; i < parent.children.length; i++) {
      var el = parent.children[i];
      if (el !== area && el.querySelector && el.querySelector("table")) return el;
    }
    return null;
  }
  function setZoom(el, z) {
    if (el) el.style.zoom = z === 1 ? "" : String(z);
  }
  /* 窗口层 zoom 自愈＋宽度兜底：本脚本改 zoom 只触发属性变更，FIT 脚本的
     childList MutationObserver 看不见（样式级变更漏报）。
     ⚠️ 乘法修正而非除法求解（2026-11-03 尺寸跳动事故）：除法 wz = vw/(rect/wz)
     隐含「rect 随 wz 乘法缩放」假设——Chrome 102 等 legacy zoom 实现下 rect
     不随自身 zoom 缩放，除法解会发散/振荡；乘法修正 wz ×= vw/rect 在两种
     语义下都单调收敛（标准语义一步到位，legacy 语义几何收敛）。
     迟滞：复位要求有余量（rect < vw-2），防贴边 ±1px 抖动。 */
  function syncWinZoom() {
    var win = playerWin();
    if (!win || !win.style) return;
    var vw = window.innerWidth;
    if (!vw) return;
    var wz = parseFloat(win.style.zoom) || 1;
    var rect = win.getBoundingClientRect().width;
    if (!rect) return;
    if (rect > vw + 1) {
      var z = (wz * vw) / rect;
      if (Math.abs(wz - z) > 0.002) win.style.zoom = String(z);
    } else if (wz !== 1 && rect < vw - 2) {
      win.style.zoom = "";
    }
  }
  function apply() {
    var svg = findArea();
    if (!svg) return;
    var area = svg.parentElement;
    /* ⚠️ 子层 style 一律存语义倍率本身（不除窗口层 wz）：wz 只作窗口级宽度
       兜底钳制（syncWinZoom），两层相乘即视觉尺寸——若子层除以 wz，wz 与
       子层 style 互相抵消又互相放大（wz 缩→子层涨），视觉宽恒定且发散。 */
    setZoom(area, k);
    var stats = findStats(area);
    if (!stats) return;
    if (k === 1) { setZoom(stats, 1); syncWinZoom(); return; }
    /* 自然高度＝当前视觉高度 ÷ 生效 zoom 链（窗口层 × 本区层） */
    var wz = winZoom(playerWin());
    var gz = wz * (parseFloat(area.style.zoom) || 1);
    var gNat = area.getBoundingClientRect().height / gz;
    var sz = parseFloat(stats.style.zoom) || 1;
    var sNat = stats.getBoundingClientRect().height / sz;
    /* 面板跟涨是「视觉等高」：面板视觉高 ≥ 游戏区视觉高 */
    setZoom(stats, Math.max(1, (gNat * k) / sNat));
    syncWinZoom();
  }
  /* 轻量轮询：棋盘自然尺寸变化（新录像/换级别）→ 重挂记忆倍率（新棋盘的
     父容器若被重建，style.zoom 归零，须重新 apply）。
     ⚠️ 防抖（2026-11-03 尺寸跳动事故）：key 须连续两 tick 一致才认——窗口层
     zoom 变化会让 natOf 测量翻转（rect 含 wz），单 tick 确认会把瞬态测量当
     「换盘面」触发连环 refit，与窗口层修正互相放大成持续振荡 */
  var pendKey = "";
  window.setInterval(function () {
    var svg = findArea();
    if (!svg) { pendKey = ""; return; }
    var n = natOf(svg);
    var key = Math.round(n.w) + "x" + Math.round(n.h);
    if (key === lastNatKey) { pendKey = ""; return; }
    if (key !== pendKey) { pendKey = key; return; }
    lastNatKey = key;
    apply();
  }, 300);
  /* 首帧即记忆倍率（2026-11-05 张老师需求：打开/换盘不许默认尺寸先闪现）：
     轮询要连续两 tick 确认「换盘面」（≈600ms），棋盘会先以 1 倍画出来再跳
     记忆倍率。改为 childList 观察到棋盘容器（重）出现时，在**微任务**里
     （本轮渲染步骤、首帧绘制之前）立刻 apply——棋盘第一帧就是记忆倍率。
     已挂倍率（cur===k）时什么都不做：回放期间的海量 DOM 变更零布局开销；
     换录像/换级别重建容器致 zoom 归零时同样由这里即刻补挂。
     300ms 轮询保留作兜底（覆盖棋盘出现后无后续 childList 变更等边角）。
     ⚠️ 只观察 childList 不观察 attributes：本脚本/FIT 改 style.zoom 不会
     反向触发本观察器（无反馈环路，2026-11-03 尺寸跳动事故不复发）。 */
  var applyQueued = false;
  function queueApply() {
    if (applyQueued) return;
    applyQueued = true;
    Promise.resolve().then(function () {
      applyQueued = false;
      var svg = findArea();
      if (!svg) return;
      var cur = parseFloat(svg.parentElement.style.zoom) || 1;
      if (Math.abs(cur - k) > 0.001) apply();
    });
  }
  new MutationObserver(queueApply).observe(document.documentElement, { childList: true, subtree: true });
  /* 视口变化：倍率是语义比例、与视口无关，只需重跑 apply（尾部含
     syncWinZoom 窗口层宽度兜底钳制，窄屏溢出照旧处理） */
  var rsRaf = 0;
  window.addEventListener("resize", function () {
    if (rsRaf) return;
    rsRaf = requestAnimationFrame(function () { rsRaf = 0; apply(); });
  });
  function inArea(t) {
    if (!(t instanceof Element)) return false;
    var svg = findArea();
    return !!svg && svg.parentElement.contains(t);
  }
  document.addEventListener("wheel", function (e) {
    if (!inArea(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    k = Math.min(K_MAX, Math.max(K_MIN, k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    saveK();
    apply();
  }, { passive: false, capture: true });
  document.addEventListener("dblclick", function (e) {
    if (!inArea(e.target)) return;
    k = 1;
    saveK();
    apply();
  });
})();
`;

/* 注入播放器 iframe 的「光标换色」样式（2026-10-14 张老师定：蓝色不好看，改亮灰）：
   cursor-arrow 箭头的 fill 是内联 style，普通 CSS 盖不住，须 !important；
   颜色与在线玩自研回放一致（#D6D6CE 填充、原深灰描边保留）。 */
const CURSOR_COLOR_SCRIPT = `
(function () {
  if (window.__flopCursorColor) return;
  window.__flopCursorColor = true;
  var style = document.createElement("style");
  style.textContent = 'symbol#cursor-arrow polygon { fill: #F0F0EA !important; }';
  document.head.appendChild(style);
})();
`;

/* 注入播放器 iframe 的「点击暗区退出」脚本：
   播放器的 background 选项渲染的遮罩层 z-index:-9999（负值），真实点击
   落在 Vue 根容器而不是遮罩上。因此按点击位置判定，窗口可视 UI 外直接
   调用 IframeAdapter 暴露的 closeVideo，与 X 同走 setExit 原生退出链路。
   2026-10-28 补一：窗口未渲染（加载/异常空窗期，.game-menu 尚不存在）时
   整个可视区都是暗区，点击一律退出。
   2026-10-28 补二（张老师实测红框）：窗口外框是透明容器且被底部控制条
   撑宽，包围盒左部盖在宿主页面内容上——用 contains() 判「窗口内」会让
   视觉暗区点击无效。改为「窗口内可视元素矩形并集」判定：有背景/边框/
   画布/表单控件的元素才算窗口 UI，透明区域一律视为暗区。 */
const MASK_EXIT_SCRIPT = `
(function () {
  if (window.__flopMaskExit) return;
  window.__flopMaskExit = true;
  /* 可视元素矩形缓存：TTL 250ms（回放中布局稳定，无需监听 mutation） */
  var rectsCache = null, rectsAt = 0;
  function paints(el) {
    var tag = el.tagName;
    if (tag === "CANVAS" || tag === "IMG" || tag === "VIDEO" || tag === "INPUT" ||
        tag === "BUTTON" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.namespaceURI && el.namespaceURI.indexOf("svg") !== -1) return true;
    var cs = window.getComputedStyle(el);
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") return true;
    if (cs.borderTopStyle !== "none" && cs.borderTopWidth !== "0px") return true;
    return false;
  }
  function inVisibleUI(winEl, x, y) {
    var now = Date.now();
    if (!rectsCache || now - rectsAt > 250) {
      rectsCache = [];
      rectsAt = now;
      var els = winEl.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        if (!paints(els[i])) continue;
        var r = els[i].getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        rectsCache.push([r.left, r.top, r.right, r.bottom]);
      }
    }
    for (var j = 0; j < rectsCache.length; j++) {
      var rc = rectsCache[j];
      if (x >= rc[0] && x <= rc[2] && y >= rc[1] && y <= rc[3]) return true;
    }
    return false;
  }
  window.addEventListener("pointerdown", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    // Ant Design 的下拉菜单/弹层挂在 body 下、位于玩家窗口之外，
    // 但它们仍是播放器自身 UI（尤其「选择本地文件」），不能按暗区退出。
    if (t.closest(".ant-menu-dropdown, .ant-menu-submenu-popup, .ant-select-dropdown, .ant-picker-dropdown, .ant-modal-root, .ant-popover, .ant-tooltip, .ant-message, input[type=file]")) return;
    var exit = function () {
      if (parent.flop && typeof parent.flop.closeVideo === "function") {
        e.preventDefault();
        e.stopPropagation();
        parent.flop.closeVideo();
      }
    };
    var menu = document.querySelector(".game-menu");
    if (!menu) { exit(); return; }
    // Vue 根 = .game-menu 向上直至 body 的直接子级
    var root = menu;
    while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
    if (root === menu) return;
    // 玩家窗口 = 根之下包含菜单的那个子树
    var win = menu;
    while (win.parentElement && win.parentElement !== root) win = win.parentElement;
    if (win === menu) return; // 结构异常：宁可保持原状也不误关
    // 命中判定＝可视元素矩形并集：透明外框/空隙一律视为暗区
    if (inVisibleUI(win, e.clientX, e.clientY)) return; // 窗口可视 UI 内：交给播放器
    exit();
  }, true);
})();
`;

 export function FlopPlayer({
  onFrame,
}: {
  /** iframe 挂载/卸载回调（2026-11-03 反作弊入册用）：练习页排名局经此把
      全屏 iframe 注册进 ownNodes 白名单——懒挂时机晚于探测器一次性注册，
      不入册会被 overlay_scan 误判成「外挂提示层」（盖满棋盘 100%）。 */
  onFrame?: (el: HTMLIFrameElement | null) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // 播放器加载完成后会回调 onload（2008 版用于激活播放按钮）；
    // 就绪瞬间若有待播请求（用户在加载完成前就点了播放），立即补播
    window.flop = window.flop ?? {};
    window.flop.onload = () => {
      const flop = window.flop;
      if (flop?.pendingUri && flop.playVideo) {
        flop.playVideo(flop.pendingUri, PLAY_OPTIONS);
        flop.pendingUri = undefined;
      }
    };

    // 注入窄屏适配 + 点遮罩退出 + 光标换色 + 游戏区滚轮缩放脚本。
    // ⚠️ 同源 iframe 的初始 about:blank 与正式文档共享同一 Window 对象：
    // 挂在 Window 上的防重入标记跨文档存活，但挂 在 Document 上的监听随旧
    // 文档作废——React effect 先于 /play 加载完成执行时，旧判定（查 window
    // flag）会把注入落进 about:blank 且永不补注（2026-11-03 实测：flag 为真
    // 而暗区退出/缩放监听全死）。因此判定必须以「文档」为单位：
    // window.__flopHostedDoc !== 当前 doc 才注入，且跳过 about:blank；
    // load 事件 + 轻量轮询双通道兜底（旧注释所述「load 先于水合发完」同样覆盖）。
    const ensureInject = () => {
      const doc = frame.contentDocument;
      if (!doc || !doc.body || !doc.defaultView) return;
      if (doc.location.href === "about:blank") return; // 初始空文档：监听会随文档替换作废，不注入
      if (doc.readyState !== "complete") return; // 未加载完，等 load 事件/下轮轮询
      if (doc.defaultView.__flopHostedDoc === doc) return; // 该文档已注入
      doc.defaultView.__flopHostedDoc = doc;
      const script = doc.createElement("script");
      script.textContent = FIT_PLAYER_SCRIPT + MASK_EXIT_SCRIPT + CURSOR_COLOR_SCRIPT + ZOOM_SCRIPT;
      doc.body.appendChild(script);
    };
    ensureInject();
    frame.addEventListener("load", ensureInject);
    const poll = window.setInterval(ensureInject, 500);
    return () => {
      frame.removeEventListener("load", ensureInject);
      window.clearInterval(poll);
    };
  }, []);

  return (
    <iframe
      ref={(el) => {
        frameRef.current = el;
        onFrame?.(el);
      }}
      className="flop-player-iframe flop-player-display-none"
      src="/play/index.html"
      title="录像播放器"
    />
  );
}
