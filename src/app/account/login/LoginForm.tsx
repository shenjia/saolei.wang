"use client";

// 登录表单：三个 tab（微信扫码 / QQ 扫码 / 账号密码）
// 扫码 iframe/跳转统一走 /api/auth/* 路由（state 生成、env、mock 判断都收敛在服务端）

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Tab = "wechat" | "qq" | "password";

const TABS: [Tab, string][] = [
  ["wechat", "微信扫码"],
  ["qq", "QQ 扫码"],
  ["password", "账号密码"],
];

// 回调错误码 → 用户可读文案
const ERROR_TEXT: Record<string, string> = {
  state: "登录状态校验失败，请重新扫码",
  nocode: "扫码授权未完成，请重试",
  exchange: "与微信/QQ 服务器通信失败，请稍后重试",
  broken: "账号数据异常，请联系管理员",
};

export default function LoginForm() {
  const [tab, setTab] = useState<Tab>("wechat");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const callbackError = useSearchParams().get("error");
  const shownError = error || (callbackError ? (ERROR_TEXT[callbackError] ?? "登录失败，请重试") : "");

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
      // 老用户未绑定微信/QQ → 强制绑定
      router.push(data.needBind ? "/account/bind" : "/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="account_login" className="box">
      <h1>登录扫雷网</h1>
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

      {tab === "password" && (
        <form className="auth_form" onSubmit={submitPassword}>
          <table className="form" cellPadding={0} cellSpacing={0}>
            <tbody>
              <tr>
                <td>用户名</td>
                <td>
                  <input
                    type="text"
                    size={25}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </td>
              </tr>
              <tr>
                <td>密码</td>
                <td>
                  <input
                    type="password"
                    size={25}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          {error && <p className="auth_error">{error}</p>}
          <button type="submit" className="auth_button" disabled={loading}>
            {loading ? "登录中…" : "登录"}
          </button>
          <p className="hint">老用户首次登录后需绑定微信或 QQ</p>
        </form>
      )}
    </div>
  );
}
