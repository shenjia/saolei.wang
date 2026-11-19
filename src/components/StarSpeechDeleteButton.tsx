// 每日一星感言「删除」小链接（九轮 2026-10-25；2026-10-27 改链接形态与赞/踩统一）：
// 管理员登录态、感言旁小链接；走站内浮窗 confirmDialog 确认后 POST /api/star action=delete。

"use client";

import { useState } from "react";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";

export function StarSpeechDeleteButton() {
  const [busy, setBusy] = useState(false);

  async function del() {
    const yes = await confirmDialog({
      title: "删除感言",
      message: "确定删除这条感言吗？删除后本人可重新发表一次；第二次删除后将不能再发表。",
      confirmText: "删 除",
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      const res = await fetch("/api/star", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error ?? "删除失败", "error", 2500);
        return;
      }
      toast("已删除", "success", 1500);
      setTimeout(() => window.location.reload(), 600);
    } finally {
      setBusy(false);
    }
  }

  return (
    <a
      href="#"
      className="star_speech_del"
      onClick={(e) => {
        e.preventDefault();
        del();
      }}
      aria-disabled={busy}
    >
      删除
    </a>
  );
}
