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

/** 播放录像（播放器未就绪时先记入待播队列，就绪后自动补播） */
export function playFlop(uri: string) {
  const flop = window.flop;
  if (!flop?.playVideo) {
    if (flop) flop.pendingUri = uri;
    return;
  }
  flop.playVideo(uri, PLAY_OPTIONS);
}

/** 「播放」按钮（对应 2008 版 Show.asp 的按钮；2026-09-26 张老师要求精简文案+前置矢量图标） */
export function PlayButton({ uri }: { uri: string }) {
  return (
    <button type="button" onClick={() => playFlop(uri)}>
      <svg className="btn_icon" viewBox="0 0 18 18" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M4.5 3v12c0 .85.93 1.36 1.64.91l9.2-6a1.07 1.07 0 0 0 0-1.82l-9.2-6A1.07 1.07 0 0 0 4.5 3z" />
      </svg>
      播放
    </button>
  );
}

/* 注入播放器 iframe 的窄屏适配脚本：
   播放器窗口（统计表 + 游戏窗 + 控制条）按桌面宽度排布（高级 ~582px），
   手机视口装不下会被裁掉。iframe 同源，注入脚本在内容超出视口时把窗口整体
   zoom 缩放到视口宽（SVG 矢量缩放无损），桌面端宽裕时不做任何缩放。 */
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

/* 注入播放器 iframe 的「点击暗区退出」脚本：
   播放器的 background 选项渲染的遮罩层 z-index:-9999（负值），按 CSS 绘制
   规则位于普通流内容之下——Vue 根容器（占满视口的无 class DIV）盖在遮罩
   之上，真实鼠标点击暗区时 target 是 Vue 根 DIV，遮罩层永远收不到事件。
   故改为判定「点击是否落在玩家窗口子树之外」：
   - 玩家窗口 = .game-menu 向上至 Vue 根（body 直接子级）下的那个窗口子树
   - 窗口外（暗区/遮罩任意位置）→ 程序化点击右上角退出菜单（CloseOutlined
     特征 path d 以 M563.8 512 开头），走播放器自己的 setExit 退出链路
   - 窗口内（棋盘/菜单/控制条）→ 不拦截，交给播放器自身交互 */
const MASK_EXIT_SCRIPT = `
(function () {
  if (window.__flopMaskExit) return;
  window.__flopMaskExit = true;
  function findExitLi() {
    var paths = document.querySelectorAll("svg path");
    for (var i = 0; i < paths.length; i++) {
      var d = paths[i].getAttribute("d") || "";
      if (d.indexOf("M563.8 512") !== 0) continue;
      var li = paths[i].closest("svg").closest(".ant-menu-submenu, li");
      if (li) return li;
    }
    return null;
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var menu = document.querySelector(".game-menu");
    if (!menu) return;
    // Vue 根 = .game-menu 向上直至 body 的直接子级
    var root = menu;
    while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
    if (root === menu) return;
    // 玩家窗口 = 根之下包含菜单的那个子树
    var win = menu;
    while (win.parentElement && win.parentElement !== root) win = win.parentElement;
    if (win === menu || win.contains(t)) return; // 窗口内：交给播放器
    var li = findExitLi();
    if (li) {
      e.preventDefault();
      e.stopPropagation();
      li.click();
    }
  }, true);
})();
`;

 export function FlopPlayer() {
  const frameRef = useRef<HTMLIFrameElement>(null);

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

    // 注入窄屏适配 + 点遮罩退出脚本。
    // ⚠️ iframe 是 SSR 直出的，load 事件往往在 React 水合前就已发完——
    // React 的 onLoad 此时收不到；必须主动查 readyState 补注入
    const inject = () => {
      const doc = frame.contentDocument;
      if (!doc || !doc.body || !doc.defaultView || "__flopFit" in doc.defaultView) return;
      const script = doc.createElement("script");
      script.textContent = FIT_PLAYER_SCRIPT + MASK_EXIT_SCRIPT;
      doc.body.appendChild(script);
    };
    if (frame.contentDocument?.readyState === "complete") inject();
    else frame.addEventListener("load", inject, { once: true });
    return () => frame.removeEventListener("load", inject);
  }, []);

  return (
    <iframe
      ref={frameRef}
      className="flop-player-iframe flop-player-display-none"
      src="/play/index.html"
      title="录像播放器"
    />
  );
}
