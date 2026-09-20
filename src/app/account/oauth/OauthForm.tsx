"use client";

// 扫码身份落地后的两个分支：
// 1. 认领老账号：输入原用户名密码，把扫码身份绑上去
// 2. 注册新账号：设置用户名/中文名/英文名，直接创建账号

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OauthForm({ providerName, nickname }: { providerName: string; nickname: string }) {
  const [mode, setMode] = useState<"claim" | "register">("claim");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function post(url: string, body: Record<string, string>) {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "操作失败");
        return;
      }
      router.push("/");
      router.refresh();
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
        该{providerName}还未关联扫雷网账号，请选择：
      </p>
      <div className="tabs auth_tabs">
        {mode === "claim" ? (
          <em className="active">认领老账号</em>
        ) : (
          <a href="#" onClick={(e) => (e.preventDefault(), setMode("claim"), setError(""))}>
            认领老账号
          </a>
        )}
        {mode === "register" ? (
          <em className="active">注册新账号</em>
        ) : (
          <a href="#" onClick={(e) => (e.preventDefault(), setMode("register"), setError(""))}>
            注册新账号
          </a>
        )}
      </div>

      {mode === "claim" ? (
        <form
          className="auth_form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            post("/api/auth/oauth/claim", {
              username: String(f.get("username") ?? ""),
              password: String(f.get("password") ?? ""),
            });
          }}
        >
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
            {loading ? "绑定中…" : `绑定并登录`}
          </button>
          <p className="hint">绑定后，该{providerName}扫码即可直接登录老账号</p>
        </form>
      ) : (
        <form
          className="auth_form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            post("/api/auth/oauth/register", {
              username: String(f.get("username") ?? ""),
              chineseName: String(f.get("chineseName") ?? ""),
              englishName: String(f.get("englishName") ?? ""),
            });
          }}
        >
          <table className="form" cellPadding={0} cellSpacing={0}>
            <tbody>
              <tr>
                <td>用户名</td>
                <td>
                  <input name="username" type="text" size={25} required autoFocus />
                </td>
              </tr>
              <tr>
                <td>中文名</td>
                <td>
                  <input name="chineseName" type="text" size={25} maxLength={4} required />
                </td>
              </tr>
              <tr>
                <td>英文名</td>
                <td>
                  <input name="englishName" type="text" size={25} maxLength={32} required />
                </td>
              </tr>
            </tbody>
          </table>
          {error && <p className="auth_error">{error}</p>}
          <button type="submit" className="auth_button" disabled={loading}>
            {loading ? "注册中…" : "注册并登录"}
          </button>
          <p className="hint">用户名为登录账号（字母/数字/下划线）；中文名为录像认证真实姓名</p>
        </form>
      )}
    </div>
  );
}
