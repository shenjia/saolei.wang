// 找回密码：申请 / 重置 两个表单
"use client";

import { useState } from "react";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "forgot", email }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "提交失败");
      return;
    }
    setMsg("如果该邮箱已注册，重置链接已发送，请在 30 分钟内查收（含垃圾邮件箱）。");
  }

  return (
    <div className="post_form">
      <p>
        <input
          type="email"
          placeholder="注册时使用的邮箱"
          style={{ width: "60%" }}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </p>
      <p>
        <button className="button active" disabled={busy || !email.trim()} onClick={onSubmit}>
          发送重置邮件
        </button>
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p>{msg}</p>}
    </div>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset", token, password }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "重置失败");
      return;
    }
    setMsg("密码已重置，请使用新密码登录。");
  }

  if (msg) {
    return (
      <p>
        {msg}{" "}
        <a className="button active" href="/account/login">
          去登录
        </a>
      </p>
    );
  }
  return (
    <div className="post_form">
      <p>
        <input
          type="password"
          placeholder="新密码（至少 6 位）"
          style={{ width: "60%" }}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </p>
      <p>
        <input
          type="password"
          placeholder="再输一遍"
          style={{ width: "60%" }}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </p>
      <p>
        <button className="button active" disabled={busy || !password} onClick={onSubmit}>
          重置密码
        </button>
      </p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
