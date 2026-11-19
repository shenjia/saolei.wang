"use client";

// /connect 授权页 · 确认授权交互（2026-11-12 元扫雷上传）
// 双模式：
// ① device flow（code 非空，元扫雷插件主链路）：说明+「允许/拒绝」→
//   POST /api/connect/authorize { app, code } 只置会话状态（token 由 APP
//   轮询公开 API poll 拉取，本页不经手）→ 每 3 秒查 poll_status，
//   status=3（APP 已拉取）时显示「绑定完成」闭环。
// ② 旧模式（code 为空，复制 / deep link 兜底）：点「允许」→ 签发并展示令牌
//   （复制 + deep link 手动唤起）。令牌明文仅本次授权成功时可见一次，刷新即不再出现。

import { useEffect, useRef, useState } from "react";
import type { ConnectApp } from "@/lib/connect-apps";

interface AuthorizeResult {
  token: string;
  expiresIn: number;
  deepLink: string;
}

/** device flow 会话状态（connect_session.status 同词表） */
type DevicePhase =
  | "await" // 0 待用户确认
  | "allowed" // 1 已允许，等 APP 拉取
  | "denied" // 2 用户拒绝
  | "done" // 3 APP 已拉取，绑定完成
  | "invalid"; // 过期/不存在

export function ConnectAuthorize({
  app,
  username,
  code,
  deviceStatus,
  ipMismatch,
}: {
  app: ConnectApp;
  username: string;
  /** device flow 会话 code；空 = 旧模式（令牌展示） */
  code?: string;
  /** 服务端渲染时的会话初始状态；null = 非会话页（旧模式） */
  deviceStatus?: number | null;
  /** 会话发起 IP 与当前页面 IP 不一致（防钓鱼警告） */
  ipMismatch?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AuthorizeResult | null>(null);
  const [copied, setCopied] = useState(false);

  const initialPhase: DevicePhase =
    code !== undefined
      ? deviceStatus === 0 || deviceStatus == null
        ? "await"
        : deviceStatus === 1
          ? "allowed"
          : deviceStatus === 2
            ? "denied"
            : deviceStatus === 3
              ? "done"
              : "invalid"
      : "await";
  const [phase, setPhase] = useState<DevicePhase>(initialPhase);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // device flow：已允许后每 3 秒自查会话状态，APP 拉取成功（status=3）即闭环
  useEffect(() => {
    if (!code || phase !== "allowed") return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/connect/poll_status?code=${encodeURIComponent(code)}`);
        const data = await res.json().catch(() => ({}));
        if (data.status === 3) {
          setPhase("done");
          if (timerRef.current) clearInterval(timerRef.current);
        } else if (data.status === "expired") {
          setPhase("invalid");
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch {
        /* 网络抖动忽略，下一轮再查 */
      }
    };
    timerRef.current = setInterval(tick, 3000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [code, phase]);

  async function authorize(deny = false) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/connect/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app: app.key, code, deny }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "授权失败，请稍后重试");
        return;
      }
      if (code) {
        // device flow：只置状态，等 APP 轮询拉取
        setPhase(deny ? "denied" : "allowed");
      } else {
        setResult({ token: data.token, expiresIn: data.expiresIn, deepLink: data.deepLink ?? "" });
      }
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

  // ────────────────────────── device flow 分支 ──────────────────────────
  if (code) {
    if (phase === "done") {
      return (
        <div>
          <p>
            <b>绑定完成！</b>「{app.name}」已接收授权令牌，可关闭本页面回到 APP。
          </p>
        </div>
      );
    }
    if (phase === "allowed") {
      return (
        <div>
          <p>
            <b>授权成功！</b>请回到「{app.name}」APP，它会自动接收令牌完成绑定（本页面正在等待 APP 确认…）。
          </p>
          <p style={{ fontSize: 13, color: "#b1b1a4" }}>
            若 APP 长时间未提示成功，请在 APP 内重新发起授权。
          </p>
        </div>
      );
    }
    if (phase === "denied") {
      return (
        <div>
          <p>
            <b>已拒绝</b>本次授权请求。若这是误操作，请回到 APP 重新发起授权。
          </p>
        </div>
      );
    }
    if (phase === "invalid") {
      return (
        <div>
          <p className="error">授权请求不存在或已过期（10 分钟内有效），请回到 APP 内重新发起授权。</p>
        </div>
      );
    }
    // phase === "await"：待用户确认
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
        {ipMismatch ? (
          <p className="error" style={{ color: "#c60" }}>
            ⚠ 本次授权请求来自其他设备/网络发起。如果您没有在「{app.name}」APP 中主动发起授权，
            请勿点击允许（谨防他人冒用授权链接）。
          </p>
        ) : null}
        {error ? (
          <p className="error" style={{ color: "#c00" }}>
            {error}
          </p>
        ) : null}
        <p style={{ marginTop: 10 }}>
          <button type="button" className="button active" disabled={busy} onClick={() => authorize(false)}>
            {busy ? "正在授权…" : "允许"}
          </button>
          <button
            type="button"
            className="button"
            style={{ marginLeft: 10 }}
            disabled={busy}
            onClick={() => authorize(true)}
          >
            拒绝
          </button>
        </p>
      </div>
    );
  }

  // ────────────────────────── 旧模式（令牌展示兜底） ──────────────────────────
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
        <button type="button" className="button active" disabled={busy} onClick={() => authorize(false)}>
          {busy ? "正在授权…" : "允许"}
        </button>
      </p>
    </div>
  );
}
