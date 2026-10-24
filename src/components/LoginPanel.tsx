"use client";

// 登录面板：账号密码为主 + 下方亮灰企鹅图标弹窗 QQ 登录（2026-10-25 张老师定，
// 参照爱给网交互，撤销原「QQ 扫码」独立 tab；微信未申请下来前不出入口）
// 独立登录页与全局登录浮窗共用（2026-09-24 拆出）
// 2026-09-24 玻璃层改版（方案01）：标签置输入框上方 + 渐隐分隔线 + 渐变黄按钮
// footer 定色（张老师）：忘记密码=灰、注册新账号=绿（/account/register 注册页待移植）
// 密码登录成功后有 onSuccess 回调走浮窗关窗逻辑，无回调则维持独立页跳转行为
// 2026-09-24 记住用户名：成功登录后默认记住，下次打开自动回填（张老师要求）
// 2026-09-24「记住密码」复选框已按张老师要求撤下（不好看），只保留用户名回填
// 2026-10-16 张老师要求：已保存用户名时自动聚焦密码框（跳过用户名框）；
// 无记忆时维持 autoFocus 用户名框不变（独立页/浮窗/切 tab 重挂载三种场景一致）

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { QQ_OAUTH_ENABLED } from "@/lib/config";
import { QqPenguinIcon, openQqLoginPopup } from "./QqLogin";
import { toast } from "./Toast";

// localStorage 键名（lp_ = login panel 前缀）
const LS_USER = "lp_user";
const LS_PASS = "lp_pass"; // 已废弃：撤下记住密码时顺手清除历史遗留

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
  nextPath = "",
}: {
  /** OAuth 回调错误码（独立页从 ?error= 读） */
  initialError?: string;
  /** 密码登录成功回调：浮窗用来关窗 + refresh；不传则按独立页行为跳转 */
  onSuccess?: () => void;
  /** 登录成功后回跳的站内路径（独立页 ?next=，2026-10-15：邮箱验证链接依赖） */
  nextPath?: string;
}) {
  const savedUser = useLSValue(LS_USER);
  // 用户手动编辑的值；undefined = 未动过 → 显示回填值
  const [draftUser, setDraftUser] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState("");
  const username = draftUser ?? savedUser;
  const [error, setError] = useState(initialError ? (ERROR_TEXT[initialError] ?? "登录失败，请重试") : "");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  // 密码框 ref：已保存用户名时挂载后把焦点从用户名框（autoFocus）接到密码框
  const passRef = useRef<HTMLInputElement>(null);

  // 聚焦决策须在水合后一次性读 localStorage（savedUser 渲染期还是 SSR 空串，
  // 等它变真值再判会闪一下用户名框）；聚焦是合法副作用，无 setState
  useEffect(() => {
    let saved = "";
    try {
      saved = localStorage.getItem(LS_USER) ?? "";
    } catch {
      /* 存储不可用则当无记忆处理 */
    }
    if (saved) passRef.current?.focus();
  }, []);

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
      // 记住用户名（只写 localStorage，异常静默）；顺带清除已废弃的密码存储
      try {
        localStorage.setItem(LS_USER, username);
        localStorage.removeItem(LS_PASS);
      } catch {
        /* 存储不可用则本次不记住 */
      }
      if (onSuccess) {
        onSuccess();
        return;
      }
      // 优先 ?next= 回跳（无则回首页）；不再强制绑定第三方（2026-10-25 张老师定）
      router.push(nextPath || "/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>登录</h1>
      <div className="lp_rule" aria-hidden="true" />

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
            onChange={(e) => setPassword(e.target.value)}
            ref={passRef}
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

        {/* 第三方登录：亮灰企鹅图标弹窗（2026-10-25 张老师定，参照爱给网）；
            微信申请下来后在此并排加微信图标 */}
        {QQ_OAUTH_ENABLED && (
          <div className="lp_oauth">
            <div className="lp_oauth_rule">其他登录方式</div>
            <div className="lp_oauth_icons">
              <button
                type="button"
                className="qq_icon_btn"
                title="QQ 登录"
                aria-label="QQ 登录"
                onClick={() => openQqLoginPopup()}
              >
                <QqPenguinIcon />
              </button>
            </div>
          </div>
        )}
      </form>
    </>
  );
}
