"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 回放按键指示器消费的最小事件结构（VideoReplay.ReplayEv 可直接传入）。 */
export interface ReplayMouseEvent {
  csec: number;
  /** 事件绝对毫秒时间戳（2026-11-12 张老师「升吧」，可选）：录像回放链路
   *  （RawVF 行 toFixed(3)）与 0.5 代排行局事件流提供，按键记录面板的 hold
   *  时长/时间列优先用它露出毫秒位；练习回放等厘秒源不传，回退 csec 口径
   *  （×10 恒整十毫秒——旧格式 AVF/MVF 事件本身只有百分秒，属源精度上限）。 */
  ms?: number;
  ev: string;
}

interface KeyRecord extends ReplayMouseEvent {
  /** 抬起行持有：与上一次同键按下的按压毫秒数；孤立抬起为 null。
   *  事件带 ms 时＝真实毫秒差（1ms 精度），否则 csec 差 ×10（厘秒网格）。 */
  holdMs: number | null;
  /** 按下/抬起成功配对时双方置真；中间覆盖行不置真。 */
  paired: boolean;
  /** 该行被左键动作区间覆盖时的位置；区间可与其他键重叠。 */
  lPos: "start" | "mid" | "end" | null;
  /** 该行被右键动作区间覆盖时的位置；区间可与其他键重叠。 */
  rPos: "start" | "mid" | "end" | null;
  /** 录像起始就处于按住态时补的「缺失按下」行。 */
  missing: boolean;
  /** 由元扫雷 cc（按钮未知）判定还原的按下行，渲染时加青色边线。 */
  inferred: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  lc: "左键按下",
  lr: "左键抬起",
  rc: "右键按下",
  rr: "右键抬起",
  /* mr＝双击/chord（导出流折叠产物：双键 chord、sc+lr 与自动双击统一折叠成
     mr，原始 lc 被删、lr 改写为 mr——353011 案：右键按住期间左键点下＝双击，
     面板不显示 mr 会让 chord 在按键记录里完全不可见，只剩裸的右键按下/抬起）。
     按下时刻已随折叠丢失，只显示单个「双击」行，不合成按下/抬起对（会伪造 0ms 配对）。 */
  mr: "双击",
  /* sc＝元扫雷 cc（双击的第二击按下，按钮未知）经 evfToRawvf 的映射。
     按钮可由当时按键态唯一判定（双击＝两键同按，cc 前必有一键还按着）：
     只有左键按着→实为右键按下，只有右键按着→实为左键按下（forward 循环
     里改写）。双键都已按住/都未按的异常流才保留 sc fallback 显示「双击」。 */
  sc: "双击",
};

/** 反向扫描一次完成按下→下一次同键抬起配对，避免长录像 O(n²)；
    动作区间用差分标记，按下→抬起之间隔着的行也归入同组连线。 */
function buildRecords(events: ReplayMouseEvent[]): KeyRecord[] {
  /* 行序只由时间决定；同刻事件保持原始先后顺序，左右列穿插的行不能跳过。
     排序键优先 ms（毫秒域行序更真实，稳定排序保留同刻原序），厘秒源回退
     csec×10 —— 两种键下原始行序都单调，排序结果与传入数组序一致。 */
  const raw: KeyRecord[] = events.filter((e) => EVENT_LABELS[e.ev]).map((e) => ({ ...e, holdMs: null, paired: false, lPos: null, rPos: null, missing: false, inferred: false })).sort((a, b) => (a.ms ?? a.csec * 10) - (b.ms ?? b.csec * 10));
  /* 录像起始已是按住态时，首个抬起前补一条「缺失按下」，时长从它起算。 */
  const rows: KeyRecord[] = [];
  let lDown = false;
  let rDown = false;
  /* 真实按住态（抬起回落）：仅用于 cc 按钮判定。lDown/rDown 只置不清
     （服务于「缺失按下」补行，见下），到 sc 时往往两侧都 true，不能用。 */
  let lHeld = false;
  let rHeld = false;
  for (const e of raw) {
    if (e.ev === "lc") { lDown = true; lHeld = true; }
    else if (e.ev === "sc") {
      /* 元 cc 按钮判定：只有左键按着→实为右键按下，只有右键按着→实为左键
         按下。改写后同键抬起自然配对（354037：rc→sc→lr → rc、lc(青)、lr）。 */
      if (lHeld && !rHeld) { e.ev = "rc"; e.inferred = true; rDown = true; rHeld = true; }
      else if (rHeld && !lHeld) { e.ev = "lc"; e.inferred = true; lDown = true; lHeld = true; }
      else if (lHeld) { rDown = true; rHeld = true; } // 双键都已按住的异常流：保留「双击」显示
      else { lDown = true; lHeld = true; }
    }
    else if (e.ev === "rc") { rDown = true; rHeld = true; }
    else if (e.ev === "lr" && !lDown) {
      rows.push({ ...e, ev: "lc", paired: false, lPos: null, rPos: null, missing: true, inferred: false });
      lDown = true;
    } else if (e.ev === "rr" && !rDown) {
      rows.push({ ...e, ev: "rc", paired: false, lPos: null, rPos: null, missing: true, inferred: false });
      rDown = true;
    } else if (e.ev === "lr") lHeld = false;
    else if (e.ev === "rr") rHeld = false;
    rows.push(e);
  }
  let leftRelease = -1;
  let rightRelease = -1;
  const coverL = new Array(rows.length + 1).fill(0);
  const coverR = new Array(rows.length + 1).fill(0);
  /* hold 时长（2026-11-12 毫秒升级）：事件带 ms 用真实毫秒差（1ms 精度），
     厘秒源回退 csec 差×10（恒整十毫秒，旧格式源精度上限）。 */
  const pairHold = (rel: KeyRecord, press: KeyRecord) =>
    rel.ms != null && press.ms != null ? Math.max(0, rel.ms - press.ms) : Math.max(0, (rel.csec - press.csec) * 10);
  for (let i = rows.length - 1; i >= 0; i--) {
    const ev = rows[i].ev;
    if (ev === "lr") leftRelease = i;
    else if (ev === "rr") rightRelease = i;
    else if (ev === "lc") {
      if (leftRelease > i) {
        rows[leftRelease].holdMs = pairHold(rows[leftRelease], rows[i]);
        rows[leftRelease].paired = true;
        rows[i].paired = true;
        coverL[i]++;
        coverL[leftRelease + 1]--;
      }
      leftRelease = -1;
    } else if (ev === "sc") {
      /* 仅异常流 fallback（孤立 sc，见 forward 判定）：按左键语义归领后续 lr。
         正常元流已在 forward 改写成 lc/rc，走上方标准配对。 */
      if (leftRelease > i) {
        rows[leftRelease].holdMs = pairHold(rows[leftRelease], rows[i]);
        rows[leftRelease].paired = true;
        rows[i].paired = true;
        leftRelease = -1;
      }
    } else if (ev === "rc") {
      if (rightRelease > i) {
        rows[rightRelease].holdMs = pairHold(rows[rightRelease], rows[i]);
        rows[rightRelease].paired = true;
        rows[i].paired = true;
        coverR[i]++;
        coverR[rightRelease + 1]--;
      }
      rightRelease = -1;
    }
  }
  let runL = 0;
  let runR = 0;
  for (let i = 0; i < rows.length; i++) {
    runL += coverL[i];
    runR += coverR[i];
    if (runL > 0) rows[i].lPos = rows[i].ev === "lc" && rows[i].paired ? "start" : rows[i].ev === "lr" && rows[i].paired ? "end" : "mid";
    if (runR > 0) rows[i].rPos = rows[i].ev === "rc" && rows[i].paired ? "start" : rows[i].ev === "rr" && rows[i].paired ? "end" : "mid";
  }
  return rows;
}

/** 单行组件 memo 化（2026-11-06 回放卡顿修复）：面板随回放统计 ~100ms 重渲染
 *  10Hz，长录像几百行全量 diff 每次都有可感知卡顿峰。records 是 useMemo 产物
 *  引用稳定，memo 后每 tick 只 touch selected 变化的两行。 */
const KeyRow = memo(function KeyRow({
  e,
  index,
  selected,
}: {
  e: KeyRecord;
  index: number;
  selected: boolean;
}) {
  const down = e.ev === "lc" || e.ev === "rc" || e.ev === "sc";
  const isLeft = e.ev === "lc" || e.ev === "lr" || e.ev === "mr" || e.ev === "sc";
  const dbl = e.ev === "mr" || e.ev === "sc" || e.inferred ? " dbl" : "";
  /* 「持续xx ms」的数字用金色（2026-11-13 张老师定稿）：抬起行正文是次灰，
     数字是取证关键值，用高亮行时间列同款金（globals.css .rk_hold）。
     hold 优先毫秒差（事件带 ms），厘秒源为整十毫秒——源精度上限。 */
  const action = down
    ? e.missing ? (isLeft ? "左键按下(缺)" : "右键按下(缺)") : EVENT_LABELS[e.ev]
    : e.ev === "mr"
    ? EVENT_LABELS.mr
    : e.holdMs === null
    ? "抬起"
    : <>持续<span className="rk_hold">{Math.round(e.holdMs)}</span>ms</>;
  return (
    <div
      className={"rk_row" + dbl + (e.lPos ? ` pair_l pair_l_${e.lPos}` : "") + (e.rPos ? ` pair_r pair_r_${e.rPos}` : "") + (down ? " down" : "") + (selected ? " current" : "")}
      data-index={index}
      aria-current={selected ? "true" : undefined}
    >
      <span className="rk_action rk_left">{isLeft ? action : ""}</span>
      <span className="rk_time">{e.ms != null ? (e.ms / 1000).toFixed(3) : (e.csec / 100).toFixed(3)}</span>
      <span className="rk_action rk_right">{isLeft ? "" : action}</span>
    </div>
  );
});

/** 最后一个已经发生的事件；开局尚未有按键时返回 -1。 */
function currentEventIndex(rows: KeyRecord[], csec: number) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].csec <= csec + 0.0001) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** 极简矢量鼠标 + 可切换的固定「按键记录」面板。
 *  页内、全屏、Flop 与在线练习共用同一视觉语义：亮灰键面=当前按住。
 *  播放时高亮先向列表底部推进，再保持底部并向上滚动；方向键可定位事件。 */
export function ReplayMouseIndicator({
  left,
  right,
  events = [],
  csec = 0,
  className = "",
  onSeek,
  panelAnchor,
  panelAnchorSelector,
  panelPortalTarget,
}: {
  left: boolean;
  right: boolean;
  events?: ReplayMouseEvent[];
  csec?: number;
  className?: string;
  /** 单位同为厘秒；传入事件后一厘秒，保证跳转后该按键状态已生效。 */
  onSeek?: (csec: number) => void;
  /** 面板顶底对齐的游戏区域；也可用选择器按当前场景查找。 */
  panelAnchor?: HTMLElement | null;
  panelAnchorSelector?: string;
  /** 在线练习传入已 registerOwn 的 body 直挂宿主，规避反作弊外来节点误判。 */
  panelPortalTarget?: HTMLElement | null;
}) {
  const uid = useId().replace(/:/g, "");
  const ids = {
    body: `rm_body_${uid}`,
    button: `rm_button_${uid}`,
    press: `rm_press_${uid}`,
    wheel: `rm_wheel_${uid}`,
  };
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRowsRef = useRef(1);
  /* 面板默认隐藏，每次进入都需手动开启（2026-11-10 张老师定）。 */
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState<{ index: number; targetCsec: number } | null>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const records = useMemo(() => buildRecords(events), [events]);
  const currentIndex = useMemo(() => currentEventIndex(records, csec), [records, csec]);
  /* seek 可能让相邻的另一侧事件也成为「当前最后事件」，但键盘选中的行
     必须保持；只有恢复播放、时钟离开本次 seek 目标后才回到自动跟随。 */
  const selected = manual && (!onSeek || Math.abs(csec - manual.targetCsec) < 0.0001)
    ? manual.index
    : currentIndex;

  /* 面板用文档坐标跟随页面滚动；顶底严格锚游戏区域，水平落在鼠标右侧。 */
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const panel = panelRef.current;
    const host = hostRef.current;
    if (!panel || !host) return;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const anchor = panelAnchor ??
        (panelAnchorSelector ? document.querySelector<HTMLElement>(panelAnchorSelector) : null) ??
        host.closest(".playable")?.querySelector<HTMLElement>(".play_board") ?? null;
      const ar = anchor?.getBoundingClientRect();
      const mr = host.getBoundingClientRect();
      if (!ar || ar.height < 1 || mr.width < 1) return;
      const width = panel.offsetWidth || 230;
      let left = mr.right + window.scrollX + 12;
      /* 右侧完全出屏时退到游戏区左侧；极窄屏最后才允许覆盖侧栏，不裁面板。 */
      if (left + width > window.scrollX + window.innerWidth - 8) {
        left = ar.left + window.scrollX - width - 12;
      }
      panel.style.left = Math.max(8, left) + "px";
      panel.style.top = ar.top + window.scrollY + "px";
      panel.style.height = ar.height + "px";
      const list = listRef.current;
      const firstRow = list?.querySelector<HTMLElement>(".rk_row");
      if (list && firstRow) visibleRowsRef.current = Math.max(1, Math.floor(list.clientHeight / firstRow.offsetHeight));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
    fit();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const ro = new ResizeObserver(schedule);
    ro.observe(panel);
    ro.observe(host);
    const anchor = panelAnchor ?? (panelAnchorSelector ? document.querySelector(panelAnchorSelector) : null);
    if (anchor) ro.observe(anchor);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open, panelAnchor, panelAnchorSelector]);

  /* 高亮只在越出可视区时滚动：自然向下走到底，之后每事件向上滚一行。 */
  useEffect(() => {
    if (!open || selected < 0) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    if (!list || !row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
    else if (rowTop < list.scrollTop) list.scrollTop = rowTop;
  }, [open, selected]);

  /* 只有本面板打开时才接管方向键；输入控件与文本编辑区保持原生行为。 */
  useEffect(() => {
    if (!open || !records.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      e.stopPropagation();
      let base = selected;
      if (base < 0) base = e.key === "ArrowDown" || e.key === "ArrowRight" ? -1 : 0;
      const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 :
        e.key === "ArrowLeft" ? -visibleRowsRef.current : visibleRowsRef.current;
      const next = Math.max(0, Math.min(records.length - 1, base + delta));
      const targetCsec = records[next].csec + 1;
      setManual({ index: next, targetCsec });
      onSeek?.(targetCsec);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, records, onSeek, selected, currentIndex]);

  /* 面板滚轮＝逐行上/下，与方向键同一 seek 链路（前台录像原地回放/练习回放/
     Flop 注入版三处口径一致：一格 deltaY=120 记一行，deltaMode=1 行模式同行；
     触控板小步平滑累计，到端点清积压防回程空放）。selected 走 ref 镜像，
     监听只挂一次不随导航重挂。面板在游戏区外，不影响棋盘滚轮缩放。 */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (!open || !records.length) return;
    const panel = panelRef.current;
    if (!panel) return;
    let acc = 0;
    const go = (index: number) => {
      const targetCsec = records[index].csec + 1;
      setManual({ index, targetCsec });
      onSeek?.(targetCsec);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      acc += (Number(e.deltaY) || 0) * (e.deltaMode === 1 ? 120 : 1);
      /* sel 为闭包内同步镜像：setManual 的重渲染是异步的，循环里读 ref 会死循环。 */
      let sel = selectedRef.current;
      const before = sel;
      while (acc >= 120 && sel < records.length - 1) { acc -= 120; sel++; go(sel); }
      while (acc <= -120 && sel > 0) { acc += 120; sel--; go(sel); }
      if (sel === before) acc = 0;
    };
    panel.addEventListener("wheel", onWheel, { passive: false });
    return () => panel.removeEventListener("wheel", onWheel);
  }, [open, records, onSeek]);

  const positionTip = () => {
    const r = hostRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 110;
    setTip({
      left: Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8)),
      top: Math.max(8, r.top - 38),
    });
  };
  const stateText = left && right ? "左右键按下" : left ? "左键按下" : right ? "右键按下" : "未按下";
  const toggle = () => setOpen((v) => !v);
  const panel = open && typeof document !== "undefined" ? (
    <div className="replay_key_panel" ref={panelRef} data-testid="replay-key-panel" onClick={(e) => e.stopPropagation()}>
      <div className="gr_title">
        <span>按键记录</span>
        <span className="gr_hint">支持鼠标滚轮/方向键导航</span>
      </div>
      <div className="rk_list" ref={listRef}>
        {records.length ? records.map((e, i) => (
          <KeyRow e={e} index={i} selected={i === selected} key={`${e.csec}-${e.ev}-${i}`} />
        )) : <div className="rk_empty">暂无按键事件</div>}
      </div>
    </div>
  ) : null;

  return (
    <>
      <div
        ref={hostRef}
        className={`replay_mouse ${className}`}
        data-left={left ? "true" : "false"}
        data-right={right ? "true" : "false"}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`鼠标按键状态：${stateText}；点击${open ? "关闭" : "打开"}按键记录`}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            toggle();
          }
        }}
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
            <linearGradient id={ids.press} x1="0" y1="0" x2="0" y2="1">
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
          <path className="rm_left" d="M31 5C16 5 7 16 7 33v2h24V5Z" fill={left ? `url(#${ids.press})` : `url(#${ids.button})`} fillOpacity={left ? 1 : 0.72} />
          <path className="rm_right" d="M33 5c15 0 24 11 24 28v2H33V5Z" fill={right ? `url(#${ids.press})` : `url(#${ids.button})`} fillOpacity={right ? 1 : 0.72} />
          {left && <path d="M10 29c1-9 6-16 13-19" fill="none" stroke="#ffffff" strokeOpacity=".8" strokeWidth="1.4" strokeLinecap="round" />}
          {right && <path d="M38 7c8 3 13 10 15 19" fill="none" stroke="#ffffff" strokeOpacity=".8" strokeWidth="1.4" strokeLinecap="round" />}
        </svg>
      </div>
      {tip && typeof document !== "undefined" && createPortal(
        <div className="replay_mouse_tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          点击{open ? "关闭" : "打开"}按键记录
        </div>,
        panelPortalTarget || document.body
      )}
      {panel && createPortal(panel, panelPortalTarget || document.body)}
    </>
  );
}
