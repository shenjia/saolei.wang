// 列表页码滑条（2026-10-14 张老师需求，设计稿 design/page-slider-v1.html；当晚二轮改版）：
// 排行 / BV 榜 / 进步榜 / 录像 / 论坛 / 用户主页动态·录像 共用。整行合一布局：
//   [···加载更多(三圆点)] [◀] [━━━━━━━滑轨] [▶] [第 n / N 页]
// · 加载更多按钮只显示三个圆点（···），放滑条左侧（有更多才显示；全部加载后隐藏）
// · 滑块前方 = 暗金色粗条（已浏览进度），其余轨道暗灰
// · 拖拽松手立即加载（无防抖，张老师 2026-10-14 定），在途请求由 Feed 侧序号门槛作废
// · 交互：拖轨道 / 点轨道直达 / ◀▶ ±1 页 / 键盘 ←→ Home End；请求在途锁定操作
// · 无 JS 降级：整行隐藏（列表仍可浏览首屏）

"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

export function PageSlider({
  page,
  pages,
  loading,
  onGoto,
  hasMore,
  onMore,
}: {
  /** 当前浏览页 */
  page: number;
  /** 总页数 */
  pages: number;
  loading: boolean;
  /** 换页请求（Feed 保证严格一页语义；loading 在途时不会再触发） */
  onGoto: (page: number) => void;
  /** 是否还有更多（控制左侧 ··· 按钮；false 时隐藏） */
  hasMore: boolean;
  /** 加载更多请求（递增批量由 Feed 侧 nextBatchSize 决定） */
  onMore: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragPage, setDragPage] = useState<number | null>(null); // 拖动中的预览页码

  // 拖动中停顿即加载（2026-10-14 三轮，张老师要求）：滑块停留在某页 ≥500ms 触发加载，
  // 不必等松手；停顿期间继续拖动（页码变化）则重置计时。全部走 ref（事件回调用），
  // 不在渲染期读写（react-hooks/refs）。
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDwellPage = useRef<number | null>(null);
  const dragPageRef = useRef<number | null>(null);
  const onGotoRef = useRef(onGoto);
  const pageRef = useRef(page);
  const loadingRef = useRef(loading);
  useEffect(() => {
    onGotoRef.current = onGoto;
    pageRef.current = page;
    loadingRef.current = loading;
  });

  function armDwell(p: number) {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    if (loadingRef.current) return; // 加载中不排队 dwell（松手/停止后再说）
    if (p !== lastDwellPage.current) {
      lastDwellPage.current = p;
      dwellTimer.current = setTimeout(() => {
        dwellTimer.current = null;
        if (dragPageRef.current === p && p !== pageRef.current && !loadingRef.current) {
          onGotoRef.current(p);
        }
      }, 500);
    }
  }
  function disarmDwell() {
    if (dwellTimer.current) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    lastDwellPage.current = null;
  }
  // 卸载清计时器
  useEffect(() => () => disarmDwell(), []);

  // 单页也渲染整行（2026-10-15 张老师要求：翻页控件只有一页时显示但全部灰色不可点）——
  // single 态：无 ··· 按钮、◀▶ 禁用、滑轨静态满格金色（pct 恒 100%）、页码「第 1 / 1 页」
  const single = pages <= 1;

  const pct = (p: number) => (single ? 100 : ((p - 1) / (pages - 1)) * 100);
  const pageFromX = (clientX: number) => {
    const rect = railRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(pages, Math.max(1, Math.round(x * (pages - 1)) + 1));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (loading || single) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pageFromX(e.clientX);
    dragPageRef.current = p;
    setDragPage(p);
    armDwell(p);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPage === null) return;
    const p = pageFromX(e.clientX);
    if (p !== dragPage) {
      dragPageRef.current = p;
      setDragPage(p);
      armDwell(p); // 页码变了 → 重置 500ms 计时
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPage === null) return;
    // 目标 = 拖动中最后预览的页码（dragPageRef）。不用 pageFromX(e.clientX) 重算——
    // 停顿加载后 ps_label 文字变宽（「第 1」→「第 185」）会挤窄轨道，同一 clientX
    // 会映射到偏后的页（2026-10-14 三轮实测 185→189 误跳）
    const target = dragPageRef.current ?? pageFromX(e.clientX);
    disarmDwell();
    dragPageRef.current = null;
    setDragPage(null);
    if (target !== page && !loading) onGoto(target); // 松手立即加载（无防抖）
  };
  const onPointerCancel = () => {
    disarmDwell();
    dragPageRef.current = null;
    setDragPage(null);
  };

  const showPage = dragPage ?? page;
  const dragging = dragPage !== null;

  return (
    <div
      className={"page_slider" + (dragging ? " dragging" : "") + (loading ? " pending" : "") + (single ? " single" : "")}
      role="slider"
      tabIndex={single ? -1 : 0}
      aria-label="页码"
      aria-valuemin={1}
      aria-valuemax={pages}
      aria-valuenow={showPage}
      onKeyDown={(e) => {
        if (loading || single) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          if (page > 1) onGoto(page - 1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          if (page < pages) onGoto(page + 1);
        } else if (e.key === "Home") {
          e.preventDefault();
          if (page !== 1) onGoto(1);
        } else if (e.key === "End") {
          e.preventDefault();
          if (page !== pages) onGoto(pages);
        }
      }}
    >
      {hasMore && (
        <button
          type="button"
          className="ps_more"
          disabled={loading}
          onMouseDown={noFocus}
          onClick={onMore}
          aria-label="加载更多"
          data-tip="加载更多"
        >
          <i />
          <i />
          <i />
        </button>
      )}
      <button
        type="button"
        className="ps_btn prev"
        disabled={loading || single || page <= 1}
        onMouseDown={noFocus}
        onClick={() => onGoto(page - 1)}
        aria-label="上一页"
      >
        ◀
      </button>
      <div
        ref={railRef}
        className="ps_rail"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div className="ps_track">
          {/* 滑块前方 = 暗金粗条（已浏览进度）；后方轨道暗灰 */}
          <div className="ps_fill" style={{ width: `${pct(showPage)}%` }} />
        </div>
        <div className="ps_thumb" style={{ left: `calc(7px + (100% - 14px) * ${pct(showPage) / 100})` }} />
        <div className="ps_bubble" style={{ left: `calc(7px + (100% - 14px) * ${pct(showPage) / 100})` }}>
          第 {showPage} 页
        </div>
      </div>
      <button
        type="button"
        className="ps_btn next"
        disabled={loading || single || page >= pages}
        onMouseDown={noFocus}
        onClick={() => onGoto(page + 1)}
        aria-label="下一页"
      >
        ▶
      </button>
      <span className="ps_label">
        第 <b>{showPage}</b> / {pages} 页
      </span>
    </div>
  );
}

const noFocus = (e: ReactMouseEvent<HTMLButtonElement>) => e.preventDefault();

/** 递增批量序列（2026-10-14 张老师需求：加载更多每次批量翻倍、100 封顶）：
 *  首击 = 一页（与首屏语义衔接），之后按整页倍数翻倍，封顶 100 条。
 *  必须取整页数（Math.ceil），否则页码语义错位。 */
export function nextBatchSize(step: number, basePageSize: number): number {
  if (step <= 0) return basePageSize;
  const n = basePageSize * 2 ** step;
  return Math.min(n, 100);
}

/** 最近翻过页的 LRU 缓存（≤30 页，回跳零请求） */
export class PageCache<T> {
  private map = new Map<number, T>();
  touch(p: number) {
    const v = this.map.get(p);
    this.map.delete(p);
    if (v !== undefined) this.map.set(p, v);
  }
  set(p: number, v: T) {
    this.map.delete(p);
    this.map.set(p, v);
    if (this.map.size > 30) this.map.delete(this.map.keys().next().value as number);
  }
  get(p: number): T | undefined {
    const v = this.map.get(p);
    if (v !== undefined) this.touch(p); // 命中即提前（LRU）
    return v;
  }
  has(p: number) {
    return this.map.has(p);
  }
}
