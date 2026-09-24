"use client";

// 登录面板：三个 tab（微信扫码 / QQ 扫码 / 账号密码）
// 独立登录页与全局登录浮窗共用（2026-09-24 拆出）
// 2026-09-24 玻璃层改版（方案01）：标签置输入框上方 + 渐隐分隔线 + 渐变黄按钮
// footer 定色（张老师）：忘记密码=灰、注册新账号=绿（/account/register 注册页待移植）
// 密码登录成功后有 onSuccess 回调走浮窗关窗逻辑，无回调则维持独立页跳转行为

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OAUTH_ENABLED } from "@/lib/config";

type Tab = "wechat" | "qq" | "password";

// OAUTH_ENABLED=false 时只剩账号密码（本地测试阶段，2026-09-24 张老师要求隐藏微信/QQ）
const TABS: [Tab, string][] = OAUTH_ENABLED
  ? [
      ["wechat", "微信扫码"],
      ["qq", "QQ 扫码"],
      ["password", "账号密码"],
    ]
  : [["password", "账号密码"]];

// 回调错误码 → 用户可读文案
const ERROR_TEXT: Record<string, string> = {
  state: "登录状态校验失败，请重新扫码",
  nocode: "扫码授权未完成，请重试",
  exchange: "与微信/QQ 服务器通信失败，请稍后重试",
  broken: "账号数据异常，请联系管理员",
};

export default function LoginPanel({
  initialError = "",
  onSuccess,
}: {
  /** OAuth 回调错误码（独立页从 ?error= 读） */
  initialError?: string;
  /** 密码登录成功回调：浮窗用来关窗 + refresh；不传则按独立页行为跳转 */
  onSuccess?: (needBind: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>(OAUTH_ENABLED ? "wechat" : "password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ? (ERROR_TEXT[initialError] ?? "登录失败，请重试") : "");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "登录失败");
        return;
      }
      if (onSuccess) {
        onSuccess(data.needBind);
        return;
      }
      // 老用户未绑定微信/QQ → 强制绑定
      router.push(data.needBind ? "/account/bind" : "/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>登录扫雷网</h1>
      <p className="lp_sub">{OAUTH_ENABLED ? "老用户首次登录后需绑定微信或 QQ" : "使用扫雷网账号继续"}</p>
      <div className="lp_rule" aria-hidden="true" />
      {OAUTH_ENABLED && (
        <div className="tabs auth_tabs">
          {TABS.map(([key, name]) =>
            tab === key ? (
              <em key={key} className="active">
                {name}
              </em>
            ) : (
              <a key={key} href="#" onClick={(e) => (e.preventDefault(), setTab(key), setError(""))}>
                {name}
              </a>
            )
          )}
        </div>
      )}

      {tab === "password" && (
        <form className="lp_form" onSubmit={submitPassword}>
          <div className="lp_field">
            <label htmlFor="login_username">用户名</label>
            <input
              id="login_username"
              type="text"
              autoComplete="username"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>
          <div className="lp_field">
            <label htmlFor="login_password">密码</label>
            <input
              id="login_password"
              type="password"
              autoComplete="current-password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <p className="lp_error">
              <i>!</i>
              {error}
            </p>
          )}
          <button type="submit" className="lp_submit" disabled={loading}>
            {loading ? (
              <>
                登录中…<span className="lp_spin" aria-hidden="true" />
              </>
            ) : (
              "登 录"
            )}
          </button>
          <div className="lp_foot">
            <a className="lp_forgot" href="/account/forgot">
              忘记密码？
            </a>
            <a className="lp_reg" href="/account/register">
              注册新账号 →
            </a>
          </div>
        </form>
      )}

      {tab === "wechat" && (
        <div className="auth_qr">
          {/* 服务端路由：已配置则 302 到微信官方二维码，未配置则显示 dev mock */}
          <iframe src="/api/auth/wechat/qr" title="微信扫码登录" />
          <p className="hint">打开微信「扫一扫」，扫码后确认登录</p>
        </div>
      )}

      {tab === "qq" && (
        <div className="auth_qr">
          <p className="hint">点击下方按钮，跳转 QQ 授权页（可扫码或一键登录）</p>
          <a className="auth_button qq" href="/api/auth/qq">
            使用 QQ 登录
          </a>
        </div>
      )}
    </>
  );
}
