"use client";

// 支出凭据查看（2026-10-30 收支管理）：前台支出记录行的票据图标，
// 点击弹遮罩浮层展示凭据图；遮罩/×/Esc/点图外任意处均可关闭。
// 视觉复用 .login_overlay 既有遮罩模式（fixed inset-0 z-9999 半透明黑）。

import { useEffect, useState } from "react";

export function ExpenseEvidence({ url, alt }: { url: string; alt: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button type="button" className="expense_ticket" title="查看凭据" aria-label={`查看凭据：${alt}`} onClick={() => setOpen(true)}>
        🧾
      </button>
      {open && (
        <div
          className="evidence_overlay"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="支出凭据"
        >
          <button type="button" className="evidence_close" aria-label="关闭" onClick={() => setOpen(false)}>
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={alt} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}
