// 发信表单（消息页与广播共用提交逻辑）
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { useDraft } from "./useDraft";

export function SendMessageForm({ to, toName, authorId }: { to?: number; toName?: string; authorId: number }) {
  // 草稿秒级备份：受控直绑 draft.value；按作者 uid + 收件人 id 隔离，与用户主页气泡浮窗共用同一份草稿
  const draft = useDraft(to ? `pm:${authorId}:${to}` : null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSend() {
    setBusy(true);
    setError("");
    setOk("");
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to, content: draft.value }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "发送失败");
      return;
    }
    setOk("已发送");
    toast("站内信已发送", "success");
    draft.clear(); // 发送成功清空草稿
  }

  if (!to) return null;
  return (
    <div className="send_form">
      <p>
        发给：<em>{toName ?? `ID ${to}`}</em>
      </p>
      <textarea
        rows={3}
        maxLength={200}
        placeholder="说点什么…（200 字以内）"
        value={draft.value}
        onChange={(e) => draft.set(e.target.value)}
      />
      <p>
        <button className="button small active" disabled={busy || !draft.value.trim()} onClick={onSend}>
          发送
        </button>{" "}
        <span className="error">{error}</span>
        <span>{ok}</span>
      </p>
    </div>
  );
}

export function ClearButton() {
  const [done, setDone] = useState(false);
  const router = useRouter();
  async function onClear() {
    if (!(await confirmDialog({ title: "清空消息", message: "确定清空所有消息吗？此操作不可恢复。" }))) return;
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error ?? "清空失败", "error");
      return;
    }
    setDone(true); // 按钮随 refresh 后隐藏
    toast("消息已清空", "success");
    router.refresh(); // 整页 location.reload 会丢 toast，改用客户端 refresh
  }
  if (done) return null;
  return (
    <button className="button small" onClick={onClear}>
      清空消息
    </button>
  );
}

/** 全部已读（2026-09-24 张老师要求：消息页右上角）；完成后 refresh 推送新列表 */
export function MarkAllReadButton({ unread }: { unread?: number }) {
  const [done, setDone] = useState(false);
  const router = useRouter();
  async function onMarkAll() {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "readall" }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error ?? "操作失败", "error");
      return;
    }
    const data = await res.json().catch(() => ({}));
    setDone(true);
    toast(`已将 ${data.count ?? 0} 条消息标记为已读`, "success");
    window.dispatchEvent(new Event("message:changed")); // 导航角标立即消失
    router.refresh();
  }
  if (done) return null;
  return (
    <button className="button small" onClick={onMarkAll} disabled={unread === 0}>
      全部已读
    </button>
  );
}

// 2026-10-27（张老师要求）：前台「全站广播」表单下线（后台 /admin/messages 已有），
// 本文件只保留发信 / 全部已读 / 清空三个按钮组件
