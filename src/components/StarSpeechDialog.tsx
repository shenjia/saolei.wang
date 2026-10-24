// 每日一星「发表感言」浮窗（2026-10-25 八轮张老师定；十一轮补字数统计）
// 当日当选者点击（首页卡片按钮 or 系统私信链接 /message?speech=1）弹出：
// 复用 .msg_dialog 发信浮窗外观，30 字以内一次性提交 /api/star action=speech；
// 输入框下实时字数统计「n/30」；成功后 toast + 刷新页面展示感言。

"use client";

import { useEffect, useState } from "react";
import { toast } from "./Toast";

export const STAR_SPEECH_LIMIT = 30;

export function StarSpeechDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/star", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "speech", speech: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "发表失败");
        return;
      }
      onClose();
      toast("感言已发表", "success", 2000);
      // 刷新让首页卡片带上感言（软导航 keep server data 新鲜）
      setTimeout(() => window.location.reload(), 800);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const len = [...text].length;
  return (
    <div
      className="msg_overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="msg_dialog" role="dialog" aria-modal="true" aria-label="发表感言">
        <h1>
          发表<em>每日一星感言</em>
        </h1>
        <div className="msg_rule" />
        <textarea
          className="msg_input"
          autoFocus
          rows={2}
          maxLength={STAR_SPEECH_LIMIT * 2}
          placeholder={`说点什么…（${STAR_SPEECH_LIMIT} 字以内，发表后不可修改）`}
          value={text}
          onChange={(e) => setText([...e.target.value].slice(0, STAR_SPEECH_LIMIT).join(""))}
        />
        {/* 实时字数统计（十一轮）：右对齐 n/30，超限变红（截断后不会超，红态兜底） */}
        <div className="star_speech_count">
          <span className={len > STAR_SPEECH_LIMIT ? "over" : ""}>{len}</span>/{STAR_SPEECH_LIMIT}
        </div>
        {error && <div className="msg_error">{error}</div>}
        <p className="msg_ops">
          <button
            type="button"
            className="msg_send"
            disabled={busy || !text.trim()}
            onClick={submit}
          >
            {busy ? "发表中…" : "发 表"}
          </button>
          <button type="button" className="msg_cancel" onClick={onClose}>
            取 消
          </button>
        </p>
      </div>
    </div>
  );
}
