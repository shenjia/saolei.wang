// 用户主页「发消息」气泡小按钮 + 发信浮窗（2026-10-13 张老师定稿，设计稿 design/message-bubble-btn.html）
// 位置上：紧贴性别图标右侧（原来的「发消息」灰色大按钮下线），20px 对话气泡图标（类微信），
//   hover 变全站绿；点击弹出带遮罩的浮窗——输入框复用录像评论同款 .wys 外观（纯文本 200 字），
//   居中「发送（黄主按钮）/ 取消（灰）」。
// 成功后：浮窗与遮罩立即消失，屏中弹绿色「发送成功」气泡，停留 2 秒后渐隐（登录成功同款）。
// 提交仍走既有接口 /api/message（action=send），文案与站内信页一致。
// variant="text"（2026-10-24 张老师要求）：消息列表「回复」入口同款浮窗——
//   渲染为行内文字链（.msg_reply_link 既有样式），点击弹浮窗而非跳页。

"use client";

import { useEffect, useState } from "react";
import { toast } from "./Toast";
import { useDraft } from "./useDraft";

/** 与 lib/message.ts 的 MESSAGE_CONTENT_LIMIT 保持一致
 *  （lib/message 依赖 prisma，不能进客户端 bundle，故此处独立声明） */
const CONTENT_LIMIT = 200;

/** 对话气泡图标：三点 + 尾巴，色随 currentColor（20px 与性别 big 图标等高）。
 *  移动版顶栏消息按钮（MobileNav）复用同款，故导出。 */
export function BubbleIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
    >
      <path
        d="M10 3.2c-4.1 0-7.4 2.8-7.4 6.3 0 1.9 1 3.7 2.6 4.9l-.7 3 3.1-1.7c.77.2 1.57.3 2.4.3 4.1 0 7.4-2.9 7.4-6.5S14.1 3.2 10 3.2z"
        strokeLinejoin="round"
      />
      <circle cx="6.9" cy="9.5" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9.5" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="13.1" cy="9.5" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SendMessageButton({
  to,
  name,
  authorId,
  variant = "bubble",
}: {
  to: number;
  name: string;
  /** 0=未登录（按钮灰置，hover「登录后可发消息」）；等于 to=看自己（「不能给自己发消息」） */
  authorId: number;
  /** bubble＝用户主页气泡图标钮（默认）；text＝消息列表行内文字链（「回复」） */
  variant?: "bubble" | "text";
}) {
  // 2026-10-25 十二轮张老师定：按钮全场景常驻——未登录/看自己时灰置不可点，
  // hover 提示原因（msg_btn--disabled + data-tip 复用全站气泡模式）
  const disabled = authorId <= 0 || authorId === to;
  const [open, setOpen] = useState(false);
  // 草稿秒级备份：受控直绑 draft.value（浮窗挂载即恢复）；按作者 uid + 收件人 id 隔离，
  // 与消息页发信表单共用同一份草稿——气泡里没发完就关掉，去消息页接着写也能接上
  const draft = useDraft(`pm:${authorId}:${to}`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Esc 关闭浮窗（与全站浮窗习惯一致）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to, content: draft.value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "发送失败");
        return;
      }
      // 成功：关浮窗 + 屏中成功气泡（2 秒后渐隐）
      setOpen(false);
      draft.clear(); // 发送成功清空草稿
      toast("发送成功", "success", 2000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {variant === "text" ? (
        <button
          type="button"
          className="msg_reply_link"
          title={`回复 ${name}`}
          onClick={() => setOpen(true)}
        >
          回复
        </button>
      ) : (
        <button
          type="button"
          className={"msg_btn" + (disabled ? " msg_btn--disabled" : "")}
          title={disabled ? undefined : `给 ${name} 发消息`}
          data-tip={disabled ? (authorId <= 0 ? "登录后可发消息" : "不能给自己发消息") : undefined}
          aria-label={disabled ? "发消息（不可用）" : "发消息"}
          aria-disabled={disabled}
          onClick={() => {
            if (!disabled) setOpen(true);
          }}
        >
          <BubbleIcon />
        </button>
      )}
      {open && (
        <div
          className="msg_overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false); // 点遮罩关闭
          }}
        >
          <div className="msg_dialog" role="dialog" aria-modal="true" aria-label="发消息">
            <h1>
              发消息给 <em>{name}</em>
            </h1>
            <div className="msg_rule" />
            <textarea
              className="msg_input"
              autoFocus
              rows={3}
              maxLength={CONTENT_LIMIT}
              placeholder={`说点什么…（${CONTENT_LIMIT} 字以内）`}
              value={draft.value}
              onChange={(e) => draft.set(e.target.value)}
            />
            {error && <div className="msg_error">{error}</div>}
            <p className="msg_ops">
              <button
                type="button"
                className="msg_send"
                disabled={busy || !draft.value.trim()}
                onClick={send}
              >
                {busy ? "发送中…" : "发 送"}
              </button>
              <button type="button" className="msg_cancel" onClick={() => setOpen(false)}>
                取 消
              </button>
            </p>
          </div>
        </div>
      )}
    </>
  );
}
