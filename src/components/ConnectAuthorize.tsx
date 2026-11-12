"use client";

// /connect 授权页 · 确认授权交互（2026-11-12 元扫雷上传）
// 状态机：说明+「允许」→ POST /api/connect/authorize → 令牌展示（复制 + deep link 手动唤起）。
// 令牌明文仅本次授权成功时可见一次（与公开 API login 同口径），刷新即不再出现。

import { useState } from "react";
import type { ConnectApp } from "@/lib/connect-apps";

interface AuthorizeResult {
  token: string;
  expiresIn: number;
  deepLink: string;
}

export function ConnectAuthorize({ app, username }: { app: ConnectApp; username: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AuthorizeResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function authorize() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/connect/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app: app.key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "授权失败，请稍后重试");
        return;
      }
      setResult({ token: data.token, expiresIn: data.expiresIn, deepLink: data.deepLink ?? "" });
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（旧浏览器/非安全上下文）：聚焦文本框让用户手动全选复制
      const el = document.getElementById("connect_token") as HTMLTextAreaElement | null;
      el?.focus();
      el?.select();
    }
  }

  if (result) {
    return (
      <div>
        <p>
          <b>授权成功！</b>以下令牌已签发给「{app.name}」（有效期 90 天）：
        </p>
        <p style={{ fontSize: 13, color: "#b1b1a4" }}>
          令牌仅本次显示一次，请立即保存；若遗失可重新授权获取新令牌（旧令牌在有效期内仍可用）。
        </p>
        <textarea
          id="connect_token"
          readOnly
          value={result.token}
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "monospace",
            fontSize: 13,
            color: "#333",
            padding: "6px 8px",
          }}
        />
        <p style={{ marginTop: 10 }}>
          <button type="button" className="button active" onClick={copyToken}>
            {copied ? "已复制" : "复制令牌"}
          </button>
          {result.deepLink ? (
            <button
              type="button"
              className="button active"
              style={{ marginLeft: 10 }}
              onClick={() => {
                window.location.href = result.deepLink;
              }}
            >
              唤起{app.name}
            </button>
          ) : null}
        </p>
        <p style={{ fontSize: 13, color: "#b1b1a4" }}>
          手机上点击「唤起{app.name}」可自动完成绑定；若未安装 APP 或未跳转，请将上方令牌粘贴到
          {app.name} APP 的授权设置中。
        </p>
      </div>
    );
  }

  return (
    <div>
      <p>
        您正在以 <b>{username}</b> 的身份授权「{app.name}」访问您的扫雷网账号。
      </p>
      <p>授权后，「{app.name}」将能够：</p>
      <ul style={{ margin: "8px 0 12px 24px", color: "#666" }}>
        {app.permissions.map((p) => (
          <li key={p} style={{ marginBottom: 4 }}>
            {p}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 13, color: "#b1b1a4" }}>
        令牌有效期 90 天，期间 APP 无需再次授权；您的账号密码不会提供给任何第三方 APP。
      </p>
      {error ? (
        <p className="error" style={{ color: "#c00" }}>
          {error}
        </p>
      ) : null}
      <p style={{ marginTop: 10 }}>
        <button type="button" className="button active" disabled={busy} onClick={authorize}>
          {busy ? "正在授权…" : "允许"}
        </button>
      </p>
    </div>
  );
}
