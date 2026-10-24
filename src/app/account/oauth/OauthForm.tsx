"use client";

// 扫码身份落地页（2026-10-25 张老师定稿）：
// 认领老账号：输入原用户名密码，把扫码身份绑上去并登录
// 注册新账号：跳转完整注册表单 /account/register（OAuth 票据随 cookie 带过去，
//             注册成功后服务端自动绑定该 QQ，不再用此处的简化三字段表单）

import { useState } from "react";
import Link from "next/link";
import { toast } from "@/components/Toast";

export default function OauthForm({ providerName, nickname }: { providerName: string; nickname: string }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function claim(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/oauth/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: String(f.get("username") ?? ""),
          password: String(f.get("password") ?? ""),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "操作失败");
        return;
      }
      toast("绑定成功", "success");
      window.location.href = "/";
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="account_oauth" className="box">
      <h1>
        {providerName}用户{nickname ? `「${nickname}」` : ""}，欢迎
      </h1>
      <p className="hint" style={{ marginTop: 0 }}>
        该{providerName}还未关联扫雷网账号。已有账号请绑定；没有账号请注册，注册后将自动关联该{providerName}。
      </p>

      <form className="auth_form" onSubmit={claim}>
        <table className="form" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td>用户名</td>
              <td>
                <input name="username" type="text" size={25} required autoFocus />
              </td>
            </tr>
            <tr>
              <td>密码</td>
              <td>
                <input name="password" type="password" size={25} required />
              </td>
            </tr>
          </tbody>
        </table>
        {error && <p className="auth_error">{error}</p>}
        <button type="submit" className="auth_button" disabled={loading}>
          {loading ? "绑定中…" : "绑定并登录"}
        </button>
        <p className="hint">绑定后，该{providerName}扫码即可直接登录老账号</p>
      </form>

      <div className="auth_choices" style={{ marginTop: 24 }}>
        <Link href="/account/register">没有账号？注册新账号 →</Link>
      </div>
    </div>
  );
}
