// 发信表单（消息页与广播共用提交逻辑）
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";

export function SendMessageForm({ to, toName }: { to?: number; toName?: string }) {
  const [content, setContent] = useState("");
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
      body: JSON.stringify({ action: "send", to, content }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "发送失败");
      return;
    }
    setOk("已发送");
    toast("站内信已发送", "success");
    setContent("");
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
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <p>
        <button className="button active" disabled={busy || !content.trim()} onClick={onSend}>
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
    if (!confirm("确定清空所有消息吗？此操作不可恢复。")) return;
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
    <button className="button" onClick={onClear}>
      清空消息
    </button>
  );
}

export function BroadcastForm() {
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function onBroadcast() {
    if (!confirm(`确定向全站所有用户广播吗？\n\n${content}`)) return;
    setBusy(true);
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "broadcast", content }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    setMsg(res.ok ? `已广播给 ${data.count} 位用户` : data.error ?? "广播失败");
    if (res.ok) {
      setContent("");
      toast(`已广播给 ${data.count} 位用户`, "success");
    }
  }

  return (
    <div className="send_form">
      <h2>全站广播（管理员）</h2>
      <textarea
        rows={3}
        maxLength={200}
        placeholder="广播内容…（200 字以内）"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <p>
        <button className="button active" disabled={busy || !content.trim()} onClick={onBroadcast}>
          {busy ? "广播中…" : "开始广播"}
        </button>{" "}
        <span>{msg}</span>
      </p>
    </div>
  );
}
