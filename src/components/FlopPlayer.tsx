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

/** 「在线播放」按钮（对应 2008 版 Show.asp 的按钮） */
export function PlayButton({ uri }: { uri: string }) {
  return (
    <button type="button" onClick={() => playFlop(uri)}>
      在线播放
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

/* 注入播放器 iframe 的「点击遮罩退出」脚本：
   播放器的 background 选项只渲染遮罩层（.fullscreen.center，z-index:-9999），
   自身没有点击退出逻辑。退出入口是右上角 menu-exit 里的 CloseOutlined 图标
   （a-sub-menu title 插槽内的 X svg）。这里监听遮罩层 click，找到 X 图标
   （特征 path d 以 M563.8 512 开头）程序化 click，走播放器自己的 setExit
   退出链路（隐藏 iframe + 回调 listener + 解除 body 滚动锁）。 */
const MASK_EXIT_SCRIPT = `
(function () {
  if (window.__flopMaskExit) return;
  window.__flopMaskExit = true;
  function findExitIcon() {
    var svgs = document.querySelectorAll("svg[viewBox='64 64 896 896'] path");
    for (var i = 0; i < svgs.length; i++) {
      var d = svgs[i].getAttribute("d") || "";
      if (d.indexOf("M563.8 512") === 0) return svgs[i].closest("svg");
    }
    return null;
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    // 命中遮罩层：.fullscreen.center 自身（无子元素区域），排除其内部内容
    if (!t.classList.contains("fullscreen") || !t.classList.contains("center")) return;
    if (t.childElementCount > 0) return;
    var icon = findExitIcon();
    if (icon) {
      var btn = icon.closest("[role=button], .ant-menu-submenu") || icon;
      btn.click();
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
