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
  /* 窗口层 zoom 自愈＋宽度兜底。
     ⚠️ 语义无关实现（2026-11-05 手机 Safari 持续缩小事故）：Safari/WebKit
     （标准化 zoom 前的版本）的 getBoundingClientRect 完全不含 zoom——自身与
     祖先的 zoom 都不影响 rect（playwright webkit 实测：582px 元素 zoom=0.5
     时 rect 仍 582，视觉渲染却是 291）；Chrome 标准语义 rect = natural ×
     全链 zoom。旧乘法修正 wz ×= vw/rect 隐含「rect 随 zoom 收缩」——WebKit
     下 rect 恒为自然宽，每轮都再乘 vw/rect < 1，zoom 指数发散到 0（用户
     实拍：窗口每 300ms 缩一档直至不可见）。
     修复：不再按实测 rect 迭代，改为「清 zoom 链测自然宽 → 目标一步直达
     z = vw/nat」。zoom 清空状态下两种语义 rect 都 = natural（语义无关点），
     通式「视觉宽 = natural × 链上 zoom 之积」两边实测均成立。
     清/恢复在同步 JS 内完成，无中间绘制不闪烁；调用频率低（缩放操作/
     换盘/resize），强制 reflow 可承受。
     迟滞：复位要求有余量（nat×wz < vw-2），防贴边 ±1px 抖动。 */
  function natSize(el) {
    var chain = [];
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.style && n.style.zoom) chain.push([n, n.style.zoom]);
    }
    for (var i = 0; i < chain.length; i++) chain[i][0].style.zoom = "";
    var r = el.getBoundingClientRect();
    for (var j = 0; j < chain.length; j++) chain[j][0].style.zoom = chain[j][1];
    return { w: r.width, h: r.height };
  }
  function syncWinZoom() {
    var win = playerWin();
    if (!win || !win.style) return;
    /* vw 用 clientWidth 与 FIT_PLAYER_SCRIPT 同源：iOS 部分 WebView 里 iframe 的
       window.innerWidth 会报页面级视口（仿真实测 980），clientWidth 才是
       iframe 文档真实视口宽 */
    var vw = document.documentElement.clientWidth || window.innerWidth;
    if (!vw) return;
    var wz = parseFloat(win.style.zoom) || 1;
    var nat = natSize(win).w;
    if (!nat) return;
    if (nat * wz > vw + 1) {
      var z = vw / nat;
      if (Math.abs(wz - z) > 0.002) win.style.zoom = String(z);
    } else if (wz !== 1 && nat * wz < vw - 2) {
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
    /* 语义无关测量（2026-11-05）：natSize 清链测自然高，两种 zoom 语义同值。
       窗口层 wz 同乘面板与游戏区双方，视觉等高比较中约掉——
       条件即 sNat × sz ≥ aNat × gz（旧 rect÷zoom 链还原在 WebKit 下必错，
       是用户实拍「数据面板缩成高窄柱」的同源根因）。 */
    var gz = parseFloat(area.style.zoom) || 1;
    var aNat = natSize(area).h;
    var sNat = natSize(stats).h;
    setZoom(stats, Math.max(1, (aNat * gz) / sNat));
    syncWinZoom();
  }
  /* 轻量轮询：棋盘尺寸变化（新录像/换级别）→ 重挂记忆倍率（新棋盘的
     父容器若被重建，style.zoom 归零，须重新 apply）。
     ⚠️ key 用原始 rect 不用 natSize：轮询 300ms 一跳，清链测量会周期性
     强制 reflow；key 只需「稳定 + 换盘变化」——WebKit 下 rect 恒为自然值
     天然稳定，Chrome 下 wz/k 变化时 key 漂移一次 → 触发一次幂等 apply。
     ⚠️ 防抖（2026-11-03 尺寸跳动事故）：key 须连续两 tick 一致才认——
     单 tick 确认会把瞬态测量当「换盘面」触发连环 refit。 */
  var pendKey = "";
  window.setInterval(function () {
    var svg = findArea();
    if (!svg) { pendKey = ""; return; }
    var r = svg.parentElement.getBoundingClientRect();
    var key = Math.round(r.width) + "x" + Math.round(r.height);
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

/* 回放矢量鼠标（2026-11-05）：读取 Flop 自身 Vuex 的播放毫秒与事件流，
   按当前时间重建按键态，倍速/暂停/seek 都不另造计时器。位置锚在
   游戏区域右侧，鼠标底部与 .svg-game 底边对齐；点击切换固定「按键记录」面板，
   面板与游戏区同高；hover 只提示开关，方向键选择/翻页并经原生进度滑块 seek。 */
const REPLAY_MOUSE_SCRIPT = `
(function () {
  if (window.__flopReplayMouse) return;
  window.__flopReplayMouse = true;
  /* 面板开关跨会话记忆，与自研回放共享同一个 localStorage key。 */
  var panelOpen = (function () { try { return window.localStorage.getItem("replayKeyPanelOpen") === "1"; } catch (e) { return false; } })();
  var host = document.createElement("div");
  host.className = "replay_mouse_flop";
  host.id = "flop_replay_mouse";
  host.tabIndex = 0;
  host.setAttribute("role", "button");
  host.setAttribute("aria-expanded", String(panelOpen));
  host.setAttribute("aria-label", "鼠标按键状态；点击" + (panelOpen ? "关闭" : "打开") + "按键记录");
  host.innerHTML = '<svg viewBox="0 0 64 88" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="flop_rm_body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5c5b50"/><stop offset=".45" stop-color="#3e3d35"/><stop offset="1" stop-color="#272822"/></linearGradient>' +
    '<linearGradient id="flop_rm_button" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a887b"/><stop offset="1" stop-color="#555449"/></linearGradient>' +
    '<linearGradient id="flop_rm_gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".48" stop-color="#e8e8e2"/><stop offset="1" stop-color="#b9b9b0"/></linearGradient>' +
    '<linearGradient id="flop_rm_wheel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6f941f"/><stop offset=".5" stop-color="#b9ec46"/><stop offset="1" stop-color="#729a21"/></linearGradient>' +
    '</defs>' +
    '<path d="M32 3C15 3 5 15 5 33v23c0 18 11 29 27 29s27-11 27-29V33C59 15 49 3 32 3Z" fill="url(#flop_rm_body)" stroke="#9a998d" stroke-width="1.4"/>' +
    '<path d="M32 5C17 5 8 16 8 32" fill="none" stroke="#d6d6c8" stroke-opacity=".45" stroke-width="1.2" stroke-linecap="round"/>' +
    '<path d="M6 36h52M32 4v32" fill="none" stroke="#20211c" stroke-width="1.6"/>' +
    '<path d="M12 66c4 10 11 15 20 15s16-5 20-15" fill="none" stroke="#161713" stroke-opacity=".55" stroke-width="1.2"/>' +
    '<rect x="27.5" y="13" width="9" height="18" rx="4.5" fill="#1c1d18" stroke="#777568"/>' +
    '<rect x="29.5" y="15" width="5" height="13" rx="2.5" fill="url(#flop_rm_wheel)"/>' +
    '<path d="M32 17v8" stroke="#d3f693" stroke-opacity=".5" stroke-width=".8"/>' +
    '<path class="rm_left" d="M31 5C16 5 7 16 7 33v2h24V5Z" fill="url(#flop_rm_button)" fill-opacity=".72"/>' +
    '<path class="rm_right" d="M33 5c15 0 24 11 24 28v2H33V5Z" fill="url(#flop_rm_button)" fill-opacity=".72"/>' +
    '</svg>';
  var style = document.createElement("style");
  style.textContent = '.replay_mouse_flop{position:fixed;width:44px;height:60px;z-index:10020;line-height:0;cursor:pointer;outline:none;display:none}' +
    '.replay_mouse_flop>svg{display:block;width:44px;height:60px;overflow:visible;filter:drop-shadow(0 5px 5px rgba(0,0,0,.38))}' +
    '.replay_mouse_flop:focus-visible>svg{filter:drop-shadow(0 0 3px #a6e22e)}' +
    '.replay_mouse_tip_flop{position:fixed;width:194px;box-sizing:border-box;padding:6px 9px;border:1px solid #656355;border-radius:4px;background:#272822;color:#f8f8f2;box-shadow:0 4px 12px rgba(0,0,0,.45);z-index:10022;pointer-events:none;font:11px/18px Arial,"PingFang SC",sans-serif;text-align:center;white-space:nowrap}' +
    '.replay_key_panel_flop{position:fixed;width:250px;box-sizing:border-box;display:flex;flex-direction:column;padding:9px 10px;border:1px solid #656355;border-radius:6px;background:#49483e;color:#b1b1a4;box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:10021;text-align:left}' +
    '.replay_key_panel_flop .gr_title{flex:0 0 auto;margin:0 2px 5px;padding:0 0 5px;border-bottom:1px solid #656355;color:#e8e8e0;font-size:14px;font-weight:bold;line-height:20px;display:flex;align-items:baseline;justify-content:space-between}' +
    '.replay_key_panel_flop .gr_hint{font-size:11px;font-weight:normal;color:#7b7a6f;white-space:nowrap}' +
    '.replay_key_panel_flop .rk_list{flex:1;min-height:0;overflow:hidden;position:relative;font:12px/23px Arial,"PingFang SC",sans-serif}' +
    '.replay_key_panel_flop .rk_row{display:grid;grid-template-columns:minmax(0,1fr) 54px minmax(0,1fr);column-gap:4px;align-items:center;height:23px;box-sizing:border-box;padding:0 4px;border-left:1px solid transparent;border-radius:3px;color:#939387;white-space:nowrap}' +
    '.replay_key_panel_flop .rk_row.pair{border-left-color:#656355}' +
    '.replay_key_panel_flop .rk_action{position:relative;align-self:stretch;min-width:0;overflow:hidden;text-overflow:ellipsis}.replay_key_panel_flop .rk_left{text-align:left;padding-left:5px}.replay_key_panel_flop .rk_right{text-align:left;padding-left:5px}' +
    '.replay_key_panel_flop .rk_row.pair_l .rk_left::before,.replay_key_panel_flop .rk_row.pair_r .rk_right::before{content:"";position:absolute;left:0;width:1px}' +
    '.replay_key_panel_flop .rk_row.pair_l .rk_left::before{background:#7fb414}.replay_key_panel_flop .rk_row.pair_r .rk_right::before{background:#e06c9f}' +
    '.replay_key_panel_flop .rk_row.pair_l_start .rk_left::before,.replay_key_panel_flop .rk_row.pair_r_start .rk_right::before{top:2px;bottom:0}' +
    '.replay_key_panel_flop .rk_row.pair_l_mid .rk_left::before,.replay_key_panel_flop .rk_row.pair_r_mid .rk_right::before{top:0;bottom:0}' +
    '.replay_key_panel_flop .rk_row.pair_l_end .rk_left::before,.replay_key_panel_flop .rk_row.pair_r_end .rk_right::before{top:0;bottom:2px}' +
    '.replay_key_panel_flop .rk_time{color:#b1b1a4;font-family:"Courier New",monospace;font-variant-numeric:tabular-nums;text-align:center}' +
    '.replay_key_panel_flop .rk_row.down .rk_action{color:#e8e8e0}' +
    '.replay_key_panel_flop .rk_row.current{background:#707068}' +
    '.replay_key_panel_flop .rk_row.current .rk_time{color:#fdc61d}' +
    '.replay_key_panel_flop .rk_empty{padding:10px 0;color:#939387;text-align:center}';
  document.head.appendChild(style);
  document.body.appendChild(host);
  var tip = document.createElement("div");
  tip.className = "replay_mouse_tip_flop";
  tip.hidden = true;
  document.body.appendChild(tip);
  var panel = document.createElement("div");
  panel.className = "replay_key_panel_flop";
  panel.setAttribute("data-testid", "replay-key-panel");
  panel.innerHTML = '<div class="gr_title"><span>按键记录</span><span class="gr_hint">↑↓浏览 ←→翻页</span></div><div class="rk_list"></div>';
  panel.hidden = !panelOpen;
  document.body.appendChild(panel);
  var list = panel.querySelector(".rk_list");
  var hovering = false, lastButtonKey = "";
  var records = [], selected = -1, lastCurrent = -2, visibleRows = 1, seeking = false, navigatedIndex = -1, navigatedTime = -1;
  var labels = { LeftPress: "左键按下", LeftRelease: "左键抬起", RightPress: "右键按下", RightRelease: "右键抬起" };
  /* videoParser.leftPressed/rightPressed 是播放器交互层的按键态，不随录像事件
     推进；录像指示器必须按 gameElapsedTime 自行重放左右键事件。游标增量前进，
     seek 回退时从流首重建，倍速与暂停都沿用 Flop 自己的播放时钟。 */
  var mouseEvents = null, mouseEventIndex = 0, mouseNow = -1;
  var replayLeft = false, replayRight = false;
  function store() {
    var roots = document.body.children;
    for (var i = 0; i < roots.length; i++) {
      var app = roots[i].__vue_app__;
      var provides = app && app._context && app._context.provides;
      if (provides && provides.store) return provides.store;
    }
    return null;
  }
  function placeHost() {
    var game = document.querySelector("svg.svg-game");
    var gr = game && game.getBoundingClientRect();
    var left, top;
    if (gr && gr.width > 0 && gr.height > 0) {
      /* 垂直只认游戏区自身底边，不能锚父页评级卡（窗口变倍/缩放后两者
         底边并不一致）。水平放在游戏区右侧，不覆盖任何棋盘格。 */
      left = gr.right + 16;
      top = gr.bottom - host.offsetHeight;
    } else {
      left = window.innerWidth - 64;
      top = window.innerHeight - 82;
    }
    host.style.left = Math.max(8, Math.min(left, window.innerWidth - 52)) + "px";
    host.style.top = Math.max(8, Math.min(top, window.innerHeight - 70)) + "px";
  }
  function placeTip() {
    if (!hovering) return;
    var r = host.getBoundingClientRect();
    tip.textContent = "点击" + (panelOpen ? "关闭" : "打开") + "按键记录";
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 97, window.innerWidth - 202)) + "px";
    tip.style.top = Math.max(8, r.top - 38) + "px";
  }
  function placePanel() {
    if (!panelOpen) return;
    var game = document.querySelector("svg.svg-game");
    var gr = game && game.getBoundingClientRect();
    var hr = host.getBoundingClientRect();
    if (!gr || gr.height < 1) return;
    var left = hr.right + 12;
    var width = panel.offsetWidth || 250;
    if (left + width > window.innerWidth - 8) left = gr.left - width - 12;
    panel.style.left = Math.max(8, left) + "px";
    panel.style.top = gr.top + "px";
    panel.style.height = gr.height + "px";
    visibleRows = Math.max(1, Math.floor(list.clientHeight / 23));
  }
  function currentRecord(nowMs) {
    var lo = 0, hi = records.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (Number(records[mid].time) <= nowMs + 0.01) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
  function buildRecords(evs) {
    records = [];
    /* 行序只由时间决定；同刻事件稳定保留原顺序，左右列穿插也逐行导航。 */
    var ordered = evs.filter(function (e) { return !!labels[e.name]; }).slice();
    ordered.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0); });
    var lDown = false, rDown = false;
    for (var i = 0; i < ordered.length; i++) {
      var e = ordered[i];
      if (!labels[e.name]) continue;
      var ev = { name: e.name, time: Number(e.time) || 0, holdMs: null, paired: false, lPos: null, rPos: null, missing: false };
      if (e.name === "LeftPress") lDown = true;
      else if (e.name === "RightPress") rDown = true;
      else if (e.name === "LeftRelease" && !lDown) {
        records.push({ name: "LeftPress", time: ev.time, holdMs: null, paired: false, lPos: null, rPos: null, missing: true });
        lDown = true;
      } else if (e.name === "RightRelease" && !rDown) {
        records.push({ name: "RightPress", time: ev.time, holdMs: null, paired: false, lPos: null, rPos: null, missing: true });
        rDown = true;
      }
      records.push(ev);
    }
    var lr = -1, rr = -1;
    var coverL = new Array(records.length + 1).fill(0), coverR = new Array(records.length + 1).fill(0);
    for (var j = records.length - 1; j >= 0; j--) {
      var name = records[j].name;
      if (name === "LeftRelease") lr = j;
      else if (name === "RightRelease") rr = j;
      else if (name === "LeftPress") {
        if (lr > j) {
          records[lr].holdMs = Math.max(0, records[lr].time - records[j].time);
          records[lr].paired = true;
          records[j].paired = true;
          coverL[j]++;
          coverL[lr + 1]--;
        }
        lr = -1;
      } else if (name === "RightPress") {
        if (rr > j) {
          records[rr].holdMs = Math.max(0, records[rr].time - records[j].time);
          records[rr].paired = true;
          records[j].paired = true;
          coverR[j]++;
          coverR[rr + 1]--;
        }
        rr = -1;
      }
    }
    var runL = 0, runR = 0;
    for (var k = 0; k < records.length; k++) {
      runL += coverL[k];
      runR += coverR[k];
      if (runL > 0) records[k].lPos = records[k].name === "LeftPress" && records[k].paired ? "start" : records[k].name === "LeftRelease" && records[k].paired ? "end" : "mid";
      if (runR > 0) records[k].rPos = records[k].name === "RightPress" && records[k].paired ? "start" : records[k].name === "RightRelease" && records[k].paired ? "end" : "mid";
    }
    lastCurrent = -2;
  }
  function paintSelection() {
    if (!panelOpen) return;
    var old = list.querySelector(".rk_row.current");
    if (old) old.classList.remove("current");
    var row = list.querySelector('[data-index="' + selected + '"]');
    if (!row) return;
    row.classList.add("current");
    var top = row.offsetTop, bottom = top + row.offsetHeight;
    if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    else if (top < list.scrollTop) list.scrollTop = top;
  }
  function buildPanel() {
    if (!panelOpen) return;
    var html = "";
    for (var i = 0; i < records.length; i++) {
      var e = records[i], down = e.name === "LeftPress" || e.name === "RightPress";
      var isLeft = e.name === "LeftPress" || e.name === "LeftRelease";
      var action = down
        ? e.missing ? (isLeft ? "左键按下(缺)" : "右键按下(缺)") : labels[e.name]
        : e.holdMs === null ? "抬起" : "持续" + Math.round(e.holdMs) + "ms";
      html += '<div class="rk_row' + (e.lPos ? " pair_l pair_l_" + e.lPos : "") + (e.rPos ? " pair_r pair_r_" + e.rPos : "") + (down ? " down" : "") + '" data-index="' + i + '">' +
        '<span class="rk_action rk_left">' + (isLeft ? action : "") + '</span>' +
        '<span class="rk_time">' + (e.time / 1000).toFixed(3) + '</span>' +
        '<span class="rk_action rk_right">' + (isLeft ? "" : action) + '</span></div>';
    }
    list.innerHTML = html || '<div class="rk_empty">暂无按键事件</div>';
    placePanel();
    paintSelection();
  }
  function seekMs(ms) {
    /* 复用 Flop 自己的进度滑块，原生完成盘面重建、播放态保持与事件索引推进。 */
    var sliders = document.querySelectorAll(".ant-slider");
    var slider = null, max = 0;
    for (var i = 0; i < sliders.length; i++) {
      var h = sliders[i].querySelector(".ant-slider-handle");
      var m = h && Number(h.getAttribute("aria-valuemax"));
      if (m > max) { max = m; slider = sliders[i]; }
    }
    var rail = slider && slider.querySelector(".ant-slider-rail");
    if (!rail || !(max > 0)) return;
    var r = rail.getBoundingClientRect();
    var x = r.left + Math.max(0, Math.min(1, ms / max)) * r.width;
    var y = r.top + r.height / 2;
    seeking = true;
    slider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, button: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
    /* 滑块一像素可跨数十毫秒；在粗定位后的极小窗口内，用原生逐事件
       变更校准盘面与事件索引，最后只把时钟推进到事件后的目标毫秒。 */
    var st = store(), target = Math.round(ms), guard = 0;
    if (st) {
      while (Number(st.state.gameElapsedTime) < target && guard++ < 2000) st.commit("performNextEvent");
      while (Number(st.state.gameElapsedTime) > target && guard++ < 4000) st.commit("performPreviousEvent");
      if (Number(st.state.gameElapsedTime) !== target) st.commit("setGameElapsedTime", target);
    }
    seeking = false;
  }
  function togglePanel() {
    panelOpen = !panelOpen;
    try { window.localStorage.setItem("replayKeyPanelOpen", panelOpen ? "1" : "0"); } catch (e) {}
    panel.hidden = !panelOpen;
    host.setAttribute("aria-expanded", String(panelOpen));
    if (panelOpen) { buildPanel(); placePanel(); }
    placeTip();
  }
  function update() {
    var st = store();
    var state = st && st.state;
    var vp = state && state.videoParser;
    if (!vp || !Array.isArray(state.gameEvents)) { host.style.display = "none"; panel.hidden = true; return; }
    host.style.display = "block";
    panel.hidden = !panelOpen;
    placeHost();
    var left = replayLeft, right = replayRight;
    var nowMs = Number(state.gameElapsedTime) || 0;
    var evs = state.gameEvents;
    if (evs !== mouseEvents || nowMs < mouseNow) {
      if (evs !== mouseEvents) { buildRecords(evs); if (panelOpen) buildPanel(); }
      mouseEvents = evs;
      mouseEventIndex = 0;
      replayLeft = replayRight = false;
    }
    while (mouseEventIndex < evs.length && Number(evs[mouseEventIndex].time) <= nowMs + 0.01) {
      var name = evs[mouseEventIndex].name;
      if (name === "LeftPress") replayLeft = true;
      else if (name === "LeftRelease") replayLeft = false;
      else if (name === "RightPress") replayRight = true;
      else if (name === "RightRelease") replayRight = false;
      mouseEventIndex++;
    }
    mouseNow = nowMs;
    left = replayLeft;
    right = replayRight;
    var key = left + "|" + right;
    if (key !== lastButtonKey) {
      lastButtonKey = key;
      host.setAttribute("data-left", String(left));
      host.setAttribute("data-right", String(right));
      var lp = host.querySelector(".rm_left"), rp = host.querySelector(".rm_right");
      lp.setAttribute("fill", left ? "url(#flop_rm_gold)" : "url(#flop_rm_button)");
      rp.setAttribute("fill", right ? "url(#flop_rm_gold)" : "url(#flop_rm_button)");
      lp.setAttribute("fill-opacity", left ? "1" : ".72");
      rp.setAttribute("fill-opacity", right ? "1" : ".72");
      host.setAttribute("aria-label", "鼠标按键状态：" + (left && right ? "左右键按下" : left ? "左键按下" : right ? "右键按下" : "未按下") + "；点击" + (panelOpen ? "关闭" : "打开") + "按键记录");
    }
    var current = currentRecord(nowMs);
    /* seek 后相邻另一侧事件可能成为 current，但不能顶掉键盘选中的行；
       恢复播放、时钟离开目标后才返回自动跟随。 */
    if (navigatedIndex >= 0 && Math.abs(nowMs - navigatedTime) > 0.02) navigatedIndex = -1;
    var nextSelected = navigatedIndex >= 0 ? navigatedIndex : current;
    if (nextSelected !== selected || current !== lastCurrent) {
      selected = nextSelected;
      lastCurrent = current;
      if (panelOpen) paintSelection();
    }
    if (panelOpen) placePanel();
  }
  host.addEventListener("click", function (e) { e.stopPropagation(); togglePanel(); });
  host.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePanel(); }
  });
  host.addEventListener("mouseenter", function () { hovering = true; tip.hidden = false; placeTip(); });
  host.addEventListener("mouseleave", function () { hovering = false; tip.hidden = true; });
  host.addEventListener("focus", function () { hovering = true; tip.hidden = false; placeTip(); });
  host.addEventListener("blur", function () { hovering = false; tip.hidden = true; });
  window.addEventListener("keydown", function (e) {
    if (seeking || !panelOpen || !records.length || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(e.key) < 0) return;
    var t = e.target;
    if (t instanceof Element && t.closest("input, textarea, select, [contenteditable=true]")) return;
    e.preventDefault(); e.stopPropagation();
    var base = selected >= 0 ? selected : currentRecord(Number(store().state.gameElapsedTime) || 0);
    if (base < 0) base = e.key === "ArrowDown" || e.key === "ArrowRight" ? -1 : 0;
    var delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" ? -visibleRows : visibleRows;
    selected = Math.max(0, Math.min(records.length - 1, base + delta));
    navigatedIndex = selected;
    navigatedTime = records[selected].time + 1;
    paintSelection();
    seekMs(navigatedTime);
  }, true);
  window.addEventListener("resize", function () { placeHost(); placeTip(); placePanel(); });
  try { parent.window.addEventListener("scroll", function () { placeHost(); placeTip(); placePanel(); }, true); } catch (e) {}
  window.setInterval(update, 32);
  update();
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
    // 回放鼠标、按键记录与提示是自有 UI，点击/悬停不按暗区退出。
    if (t.closest(".replay_mouse_flop, .replay_key_panel_flop, .replay_mouse_tip_flop")) return;
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
      script.textContent = FIT_PLAYER_SCRIPT + MASK_EXIT_SCRIPT + CURSOR_COLOR_SCRIPT + ZOOM_SCRIPT + REPLAY_MOUSE_SCRIPT;
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
