"use client";

// 反作弊复核页「发消息」按钮（2026-10-27 张老师要求）
// 表格行内一个按钮，点开站内浮窗写文案 → user.sendSystemMessage（manager 及以上，
// 与用户详情页「发送系统通知」同一个 op，权限与 200 字上限口径一致）。
// 浮窗视觉直接复用 confirmDialog 的遮罩/暗玻璃面板（.confirm_overlay / .confirm_dialog），
// 不新造一套弹层样式；提交走 useOp（toast + router.refresh 统一）。

import { useEffect, useRef, useState } from "react";
import { useOp } from "./AdminAction";

/** 与 src/lib/message.ts 的 MESSAGE_CONTENT_LIMIT 同值——那边是服务端模块（含 prisma），
 *  客户端组件不能 import，否则 prisma 进浏览器包。服务端 toText(…,200) 另有一道兜底 */
const CONTENT_LIMIT = 200;

export function SendMessageButton({ uid, name }: { uid: number; name: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const { run, busy } = useOp();
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    area.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    if (!busy) setOpen(false);
  }

  async function submit() {
    const text = content.trim();
    if (!text) return;
    const ok = await run("user.sendSystemMessage", { id: uid, content: text });
    if (ok) {
      setContent("");
      setOpen(false);
    }
  }

  return (
    <>
      <button type="button" className="admin_btn sm" onClick={() => setOpen(true)}>
        发消息
      </button>
      {open && (
        <div className="confirm_overlay" onClick={close}>
          <div
            className="confirm_dialog"
            role="dialog"
            aria-modal="true"
            aria-label="发系统消息"
            onClick={(e) => e.stopPropagation()}
          >
            <a
              className="login_close"
              href="#"
              aria-label="关闭"
              onClick={(e) => (e.preventDefault(), close())}
            >
              ×
            </a>
            <h1>发系统消息</h1>
            <p className="confirm_desc">
              收件人：{name}（#{uid}）
              <br />
              以「系统消息」身份送达对方收件箱，发送后不可撤回。
            </p>
            <div className="confirm_content">
              <textarea
                ref={area}
                className="admin_textarea"
                maxLength={CONTENT_LIMIT}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="例如：你上传的录像 #123 已通过审核，感谢分享。"
              />
              <div className="admin_hint" style={{ marginTop: 6 }}>
                {content.length} / {CONTENT_LIMIT} 字
              </div>
            </div>
            <div className="confirm_ops">
              <button type="button" className="button small" onClick={close} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="button small active"
                onClick={submit}
                disabled={busy || !content.trim()}
              >
                {busy ? "发送中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
