"use client";

// 登录面板：三个 tab（微信扫码 / QQ 扫码 / 账号密码）
// 独立登录页与全局登录浮窗共用（2026-09-24 拆出）
// 2026-09-24 玻璃层改版（方案01）：标签置输入框上方 + 渐隐分隔线 + 渐变黄按钮
// footer 定色（张老师）：忘记密码=灰、注册新账号=绿（/account/register 注册页待移植）
// 密码登录成功后有 onSuccess 回调走浮窗关窗逻辑，无回调则维持独立页跳转行为
// 2026-09-24 记住登录（张老师要求）：用户名在每次成功登录后默认记住；
// 「记住密码」勾选时密码一并存本机（localStorage，明文=浏览器记住密码同级风险），取消勾选即清除

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { OAUTH_ENABLED } from "@/lib/config";
import { toast } from "./Toast";

// localStorage 键名（lp_ = login panel 前缀）
const LS_USER = "lp_user";
const LS_PASS = "lp_pass";

// 用 useSyncExternalStore 读 localStorage：SSR/水合期返回 ""（不产生水合警告），
// 水合后自动切到客户端快照补上真值；storage 事件天然跨标签页同步。
// 不在 effect 里 setState（react-hooks/set-state-in-effect 禁止，且会多一次渲染）
function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
function useLSValue(key: string): string {
  return useSyncExternalStore(
    subscribeStorage,
    () => {
      try {
        return localStorage.getItem(key) ?? "";
      } catch {
        return "";
      }
    },
    () => ""
  );
}

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
  const savedUser = useLSValue(LS_USER);
  const savedPass = useLSValue(LS_PASS);
  // 用户手动编辑的值；undefined = 未动过 → 显示回填值
  const [draftUser, setDraftUser] = useState<string | undefined>(undefined);
  const [draftPass, setDraftPass] = useState<string | undefined>(undefined);
  // 勾选态：用户手动改过用手动值，否则默认「本机存过密码=勾选」
  const [manualRemember, setManualRemember] = useState<boolean | null>(null);
  const rememberChecked = manualRemember ?? !!savedPass;
  const username = draftUser ?? savedUser;
  const password = draftPass ?? savedPass;
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
      // 登录成功：居中绿色气泡（浮窗/独立页/绑定跳转三种去向都提示）
      toast("登录成功", "success");
      // 记住登录：用户名必记；密码按勾选（只写 localStorage，异常静默）
      try {
        localStorage.setItem(LS_USER, username);
        if (rememberChecked) localStorage.setItem(LS_PASS, password);
        else localStorage.removeItem(LS_PASS);
      } catch {
        /* 存储不可用则本次不记住 */
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
      <h1>登录</h1>
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
          {/* 2026-09-24 张老师定稿：无标签纯占位字（C 方案），识别靠 placeholder + 位置 */}
          <div className="lp_field">
            <input
              id="login_username"
              type="text"
              aria-label="用户名"
              autoComplete="username"
              placeholder="用户名"
              value={username}
              onChange={(e) => setDraftUser(e.target.value)}
              autoFocus
            />
          </div>
          <div className="lp_field">
            <input
              id="login_password"
              type="password"
              aria-label="密码"
              autoComplete="current-password"
              placeholder="密码"
              value={password}
              onChange={(e) => setDraftPass(e.target.value)}
            />
          </div>
          <label className="lp_remember">
            <input
              type="checkbox"
              checked={rememberChecked}
              onChange={(e) => setManualRemember(e.target.checked)}
            />
            记住密码
          </label>
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
          {OAUTH_ENABLED && <p className="lp_hint">老用户首次登录后需绑定微信或 QQ</p>}
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
