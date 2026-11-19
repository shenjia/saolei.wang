// 每日一星「撰写当选感言」浮窗（2026-10-25 八轮张老师定；十一轮补字数统计）
// 当日当选者或预写用户点击（首页标题图标 or 系统私信链接 /message?speech=1）弹出：
// 复用 .msg_dialog 发信浮窗外观，30 字以内一次性提交 /api/star action=speech；
// 输入框下实时字数统计「n/30」；成功后 toast + 刷新页面展示感言。
// 2026-11-11 张老师定：标题「发表」→「撰写」、按钮「发表」→「提交」；
// 按钮下深灰小字说明预写制用途与「当选当日可再修改一次」；传入 initialText 时
// （当选当日改一次场景）预填原感言供修改。

"use client";

import { useEffect, useState } from "react";
import { toast } from "./Toast";

export const STAR_SPEECH_LIMIT = 30;

export function StarSpeechDialog({
  open,
  onClose,
  initialText,
}: {
  open: boolean;
  onClose: () => void;
  /** 原感言（当选当日「再修改一次」场景预填；空=全新撰写） */
  initialText?: string;
}) {
  const [text, setText] = useState(initialText ?? "");
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
      toast("感言已提交", "success", 2000);
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
      <div className="msg_dialog" role="dialog" aria-modal="true" aria-label="撰写当选感言">
        <h1>
          撰写<em>每日一星感言</em>
        </h1>
        <div className="msg_rule" />
        <textarea
          className="msg_input"
          autoFocus
          rows={2}
          maxLength={STAR_SPEECH_LIMIT * 2}
          placeholder={`说点什么…（${STAR_SPEECH_LIMIT} 字以内）`}
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
            {busy ? "提交中…" : "提 交"}
          </button>
          <button type="button" className="msg_cancel" onClick={onClose}>
            取 消
          </button>
        </p>
        {/* 预写制说明（2026-11-11 张老师定）：按钮下方深灰小字一行 */}
        <p className="star_speech_note">当选每日一星时，将自动使用本感言，当日可再修改一次。</p>
      </div>
    </div>
  );
}
