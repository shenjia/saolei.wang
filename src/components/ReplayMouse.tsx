"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 回放按键指示器消费的最小事件结构（VideoReplay.ReplayEv 可直接传入）。 */
export interface ReplayMouseEvent {
  csec: number;
  ev: string;
}

const EVENT_LABELS: Record<string, string> = {
  lc: "左键按下",
  lr: "左键抬起",
  rc: "右键按下",
  rr: "右键抬起",
};

/** 极简矢量鼠标 + 最近五条按键事件 hover 层。
 *  页内、全屏与 Flop 共用同一视觉语义：亮灰键面=当前按住；
 *  hover 层只读当前进度之前的事件，seek 后随 csec 立即重算。 */
export function ReplayMouseIndicator({
  left,
  right,
  events = [],
  csec = 0,
  className = "",
  portal = true,
}: {
  left: boolean;
  right: boolean;
  events?: ReplayMouseEvent[];
  csec?: number;
  className?: string;
  /** 在线练习挂已登记的局部宿主，浮层留在同一子树；其余场景挂 body 防裁剪。 */
  portal?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const ids = {
    body: `rm_body_${uid}`,
    button: `rm_button_${uid}`,
    gold: `rm_gold_${uid}`,
    wheel: `rm_wheel_${uid}`,
  };
  const hostRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number; placement: "right" | "top" } | null>(null);
  const recent = useMemo(
    () => events.filter((e) => e.csec <= csec && EVENT_LABELS[e.ev]).slice(-5),
    [events, csec]
  );
  const calcTip = (r: DOMRect) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    /* 右侧至少保留事件层宽 + 12px 间距；不够就整体翻到鼠标上方。 */
    if (vw - r.right >= 196) {
      return {
        left: r.right + 12,
        top: Math.max(8, Math.min(r.top, vh - 158)),
        placement: "right" as const,
      };
    }
    return {
      left: Math.max(8, Math.min(r.right - 184, vw - 192)),
      top: Math.max(8, r.top - 150),
      placement: "top" as const,
    };
  };
  const positionTip = () => {
    const r = hostRef.current?.getBoundingClientRect();
    if (r) setTip(calcTip(r));
  };
  const hovering = tip !== null;
  useEffect(() => {
    if (!hovering) return;
    const follow = () => {
      const r = hostRef.current?.getBoundingClientRect();
      if (!r) return;
      const next = calcTip(r);
      setTip((old) => old && old.left === next.left && old.top === next.top && old.placement === next.placement ? old : next);
    };
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [hovering]);
  const stateText = left && right ? "左右键按下" : left ? "左键按下" : right ? "右键按下" : "未按下";
  return (
    <div
      ref={hostRef}
      className={`replay_mouse ${className}`}
      data-left={left ? "true" : "false"}
      data-right={right ? "true" : "false"}
      role="img"
      tabIndex={0}
      aria-label={`鼠标按键状态：${stateText}；聚焦或悬停查看最近按键事件`}
      onMouseEnter={positionTip}
      onMouseLeave={() => setTip(null)}
      onFocus={positionTip}
      onBlur={() => setTip(null)}
    >
      <svg viewBox="0 0 64 88" aria-hidden="true">
        <defs>
          <linearGradient id={ids.body} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#5c5b50" />
            <stop offset=".45" stopColor="#3e3d35" />
            <stop offset="1" stopColor="#272822" />
          </linearGradient>
          <linearGradient id={ids.button} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8a887b" />
            <stop offset="1" stopColor="#555449" />
          </linearGradient>
          <linearGradient id={ids.gold} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".48" stopColor="#e8e8e2" />
            <stop offset="1" stopColor="#b9b9b0" />
          </linearGradient>
          <linearGradient id={ids.wheel} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6f941f" />
            <stop offset=".5" stopColor="#b9ec46" />
            <stop offset="1" stopColor="#729a21" />
          </linearGradient>
        </defs>
        <path d="M32 3C15 3 5 15 5 33v23c0 18 11 29 27 29s27-11 27-29V33C59 15 49 3 32 3Z" fill={`url(#${ids.body})`} stroke="#9a998d" strokeWidth="1.4" />
        <path d="M32 5C17 5 8 16 8 32" fill="none" stroke="#d6d6c8" strokeOpacity=".45" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M6 36h52M32 4v32" fill="none" stroke="#20211c" strokeWidth="1.6" />
        <path d="M12 66c4 10 11 15 20 15s16-5 20-15" fill="none" stroke="#161713" strokeOpacity=".55" strokeWidth="1.2" />
        <rect x="27.5" y="13" width="9" height="18" rx="4.5" fill="#1c1d18" stroke="#777568" strokeWidth="1" />
        <rect x="29.5" y="15" width="5" height="13" rx="2.5" fill={`url(#${ids.wheel})`} />
        <path d="M32 17v8" stroke="#d3f693" strokeOpacity=".5" strokeWidth=".8" />
        <path className="rm_left" d="M31 5C16 5 7 16 7 33v2h24V5Z" fill={left ? `url(#${ids.gold})` : `url(#${ids.button})`} fillOpacity={left ? 1 : 0.72} />
        <path className="rm_right" d="M33 5c15 0 24 11 24 28v2H33V5Z" fill={right ? `url(#${ids.gold})` : `url(#${ids.button})`} fillOpacity={right ? 1 : 0.72} />
        {left && <path d="M10 29c1-9 6-16 13-19" fill="none" stroke="#ffffff" strokeOpacity=".8" strokeWidth="1.4" strokeLinecap="round" />}
        {right && <path d="M38 7c8 3 13 10 15 19" fill="none" stroke="#ffffff" strokeOpacity=".8" strokeWidth="1.4" strokeLinecap="round" />}
      </svg>
      {tip && (() => {
        const layer = (
          <div
            className="replay_mouse_events"
            style={{ left: tip.left, top: tip.top }}
            data-placement={tip.placement}
            data-testid="replay-mouse-events"
          >
            {recent.length ? recent.map((e, i) => (
              <div className={"rme_row" + (e.ev === "lc" || e.ev === "rc" ? " down" : "")} key={`${e.csec}-${e.ev}-${i}`}>
                <span className="rme_time">{(e.csec / 100).toFixed(3)}</span>
                <span>{EVENT_LABELS[e.ev]}</span>
              </div>
            )) : <div className="rme_empty">暂无按键事件</div>}
          </div>
        );
        return portal && typeof document !== "undefined" ? createPortal(layer, document.body) : layer;
      })()}
    </div>
  );
}
