"use client";

// 全站「点人名弹卡片」浮层（2026-09-23 张老师要求）
// 捕获阶段拦截 document 上所有 a[href^="/user/N"] 点击：preventDefault 阻止跳转，
// 拉 /api/usercard/N 在点击处弹个人信息卡片；点浮层外 / ESC / 滚动时关闭。
// 唯一例外：带 data-uc-nav 的链接（卡片上的「进入TA的地盘」按钮）保持正常跳转。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UserCard } from "./UserCard";
import type { UserCardData } from "@/lib/usercard";

type CardJson = UserCardData & { own: boolean };

interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

const POPOVER_W = 322; // .uc_popover 定宽（卡片 320 + 边框）
const GAP = 6;

export function UserCardPopover() {
  const [open, setOpen] = useState<{ id: number; rect: AnchorRect } | null>(null);
  const [card, setCard] = useState<CardJson | "loading" | "error" | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null); // 触发的人名链接，滚动时跟随定位
  const cacheRef = useRef(new Map<number, CardJson>());
  const reqRef = useRef(0); // 防竞态：只采纳最后一次请求

  const close = useCallback(() => {
    setOpen(null);
    setCard(null);
    setPos(null);
    anchorRef.current = null;
  }, []);

  // 页面滚动：浮层跟随人名；人名滚出视口则关闭
  const onScroll = useCallback(() => {
    const a = anchorRef.current;
    if (!a || !a.isConnected) return close();
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return close();
    setOpen((o) => (o ? { ...o, rect: { left: r.left, top: r.top, bottom: r.bottom } } : o));
  }, [close]);

  // 点击浮层后按实际尺寸定位（下方优先，放不下则翻到人名上方；水平贴边 clamp）
  useLayoutEffect(() => {
    if (!open || !popRef.current) return;
    const el = popRef.current;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let x = open.rect.left;
    x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    let y = open.rect.bottom + GAP;
    if (y + h > window.innerHeight - 4) {
      y = Math.max(4, open.rect.top - h - GAP);
    }
    setPos({ x, y });
  }, [open, card]);

  useEffect(() => {
    function openCard(id: number, anchor: Element, rect: AnchorRect) {
      anchorRef.current = anchor;
      setOpen({ id, rect });
      setPos(null);
      const cached = cacheRef.current.get(id);
      if (cached) {
        setCard(cached);
        return;
      }
      setCard("loading");
      const seq = ++reqRef.current;
      fetch(`/api/usercard/${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: CardJson) => {
          cacheRef.current.set(id, data);
          if (reqRef.current === seq) setCard(data);
        })
        .catch(() => {
          if (reqRef.current === seq) setCard("error");
        });
    }

    // 捕获阶段：先于 next/link 的跳转处理器拿到事件
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof Element)) return;
      // 浮层内部点击：不关（除非点了链接要跳转）
      if (popRef.current?.contains(t)) {
        if (t.closest("a")) close();
        return;
      }
      const a = t.closest('a[href^="/user/"]');
      // Cmd/Ctrl/Shift+点击 = 用户想新标签打开详情页，放行（中键走 auxclick 本就不拦截）
      // 评论区（.comments）的人名不弹卡（2026-09-23 张老师要求），保持普通链接跳转
      if (
        a &&
        !a.closest(".comments") &&
        !a.hasAttribute("data-uc-nav") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey
      ) {
        const m = (a.getAttribute("href") ?? "").match(/^\/user\/(\d+)/);
        if (m) {
          e.preventDefault();
          const r = a.getBoundingClientRect();
          openCard(Number(m[1]), a, { left: r.left, top: r.top, bottom: r.bottom });
          return;
        }
      }
      // 点到其他任何地方：关闭
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [close, onScroll]);

  if (!open) return null;
  return (
    <div
      ref={popRef}
      className="uc_popover"
      style={{
        left: pos?.x ?? open.rect.left,
        top: pos?.y ?? open.rect.bottom + GAP,
        width: POPOVER_W,
        visibility: pos ? "visible" : "hidden", // 先量尺寸再显示，避免跳动
      }}
    >
      {/* 旧版「查看信息」标题栏复刻；× 关闭（点外部 / ESC / 滚动也可关） */}
      <div className="uc_head">
        查看信息
        <button type="button" className="uc_close" onClick={close} aria-label="关闭">
          ×
        </button>
      </div>
      {card === "loading" || card === null ? (
        <div className="uc_popover_tip">加载中…</div>
      ) : card === "error" ? (
        <div className="uc_popover_tip">加载失败</div>
      ) : (
        <UserCard card={card} own={card.own} />
      )}
    </div>
  );
}
