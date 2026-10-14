// 列表页码滑条（2026-10-14 张老师需求，设计稿 design/page-slider-v1.html v1.4）：
// 排行 / BV 榜 / 进步榜 / 录像 / 论坛五个长列表共用。拇指（金黄）= 当前浏览页，
// 暗绿填充 = 已加载窗口 [winStart, winEnd] 跨度。拖拽松手立即加载（无防抖，
// 张老师 2026-10-14 定），在途请求由 Feed 侧序号门槛作废，本组件只管交互不碰数据。
// 交互：拖轨道 / 点轨道直达 / ◀▶ ±1 页 / 键盘 ←→ Home End；请求在途锁定操作。
// 无 JS 降级：整行隐藏（加载更多仍可用）。

"use client";

import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

export function PageSlider({
  page,
  pages,
  winStart,
  winEnd,
  loading,
  onGoto,
}: {
  /** 当前浏览页 */
  page: number;
  /** 总页数 */
  pages: number;
  /** 已加载窗口起始页 */
  winStart: number;
  /** 已加载窗口结束页 */
  winEnd: number;
  loading: boolean;
  /** 换页请求（Feed 保证严格一页语义；loading 在途时不会再触发） */
  onGoto: (page: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragPage, setDragPage] = useState<number | null>(null); // 拖动中的预览页码

  if (pages <= 1) return null;

  const pct = (p: number) => (pages <= 1 ? 0 : ((p - 1) / (pages - 1)) * 100);
  const pageFromX = (clientX: number) => {
    const rect = railRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(pages, Math.max(1, Math.round(x * (pages - 1)) + 1));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (loading) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragPage(pageFromX(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPage === null) return;
    setDragPage(pageFromX(e.clientX));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPage === null) return;
    const target = pageFromX(e.clientX);
    setDragPage(null);
    if (target !== page) onGoto(target); // 松手立即加载（无防抖）
  };
  const onPointerCancel = () => setDragPage(null);

  const showPage = dragPage ?? page;
  const dragging = dragPage !== null;

  return (
    <div
      className={"page_slider" + (dragging ? " dragging" : "") + (loading ? " pending" : "")}
      role="slider"
      tabIndex={0}
      aria-label="页码"
      aria-valuemin={1}
      aria-valuemax={pages}
      aria-valuenow={showPage}
      onKeyDown={(e) => {
        if (loading) return;
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
      <button
        type="button"
        className="ps_btn prev"
        disabled={loading || page <= 1}
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
          <div
            className="ps_fill"
            style={{ left: `${pct(winStart)}%`, width: `${Math.max(0, pct(winEnd) - pct(winStart))}%` }}
          />
        </div>
        <div className="ps_thumb" style={{ left: `calc(7px + (100% - 14px) * ${pct(showPage) / 100})` }} />
        <div className="ps_bubble" style={{ left: `calc(7px + (100% - 14px) * ${pct(showPage) / 100})` }}>
          第 {showPage} 页
        </div>
        <div className="ps_pending">加载中…</div>
      </div>
      <button
        type="button"
        className="ps_btn next"
        disabled={loading || page >= pages}
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
