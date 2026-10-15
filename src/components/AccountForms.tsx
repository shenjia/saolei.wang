// 账号中心表单：修改资料 / 修改密码（移植 forms/ProfileForm、PasswordForm）

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AvatarUploader } from "./AvatarUploader";
import { toast } from "./Toast";

// 字段长度限制（移植 UserConfig::INFO_*_LIMIT；2026-09-25 移除自我介绍字段，只保留爱好）
const LIMITS = { qq: 15, nickname: 10, mouse: 30, pad: 30, interest: 50 } as const;

export interface ProfileDefaults {
  qq: string;
  nickname: string;
  mouse: string;
  pad: string;
  interest: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
}

/** 头像槽位数据（2026-09-24：头像上传并入「修改资料」表单第一行） */
export interface AvatarSlot {
  currentUrl: string;
  pendingUrl?: string | null;
  pendingReason?: string;
  rejected?: { reason: string } | null;
}

export function ProfileForm({ defaults, avatarSlot }: { defaults: ProfileDefaults; avatarSlot: AvatarSlot }) {
  const router = useRouter();
  const [form, setForm] = useState(defaults);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (k: keyof ProfileDefaults) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.type === "select-one" ? parseInt(e.target.value, 10) || 0 : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? "保存失败" });
        return;
      }
      setMessage({ ok: true, text: "保存成功" });
      toast("资料已保存", "success");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1900 + 1 }, (_, i) => currentYear - i);
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <form id="profile-form" onSubmit={submit}>
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          <AvatarUploader {...avatarSlot} />
          <tr>
            <th>爱好</th>
            <td>
              <div>
                <textarea style={{ width: 300 }} rows={3} maxLength={LIMITS.interest} value={form.interest} onChange={set("interest")} />
              </div>
            </td>
          </tr>
          <tr>
            <th>QQ</th>
            <td>
              <div>
                <input type="text" size={LIMITS.qq} maxLength={LIMITS.qq} value={form.qq} onChange={set("qq")} />
              </div>
            </td>
          </tr>
          <tr>
            <th>昵称</th>
            <td>
              <div>
                <input type="text" size={LIMITS.nickname} maxLength={LIMITS.nickname} value={form.nickname} onChange={set("nickname")} />
              </div>
            </td>
          </tr>
          <tr>
            <th>鼠标</th>
            <td>
              <div>
                <input type="text" size={LIMITS.mouse} maxLength={LIMITS.mouse} value={form.mouse} onChange={set("mouse")} />
              </div>
            </td>
          </tr>
          <tr>
            <th>鼠标垫</th>
            <td>
              <div>
                <input type="text" size={LIMITS.pad} maxLength={LIMITS.pad} value={form.pad} onChange={set("pad")} />
              </div>
            </td>
          </tr>
          <tr>
            <th>生日</th>
            <td className="middle">
              <div>
                <select value={form.birthYear} onChange={set("birthYear")}>
                  <option value={0}>　</option>
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
                <select value={form.birthMonth} onChange={set("birthMonth")}>
                  <option value={0}>　</option>
                  {months.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <select value={form.birthDay} onChange={set("birthDay")}>
                  <option value={0}>　</option>
                  {days.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            </td>
          </tr>
          <tr>
            <th></th>
            <td>
              <button type="submit" className="button active" disabled={submitting}>
                保存
              </button>
              {message && (
                <div className={message.ok ? "hint" : "error"} style={{ marginTop: 8 }}>
                  {message.text}
                </div>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </form>
  );
}

export function PasswordForm() {
  const router = useRouter();
  const [form, setForm] = useState({ password: "", newPassword: "", newRepeat: "" });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? "修改失败" });
        return;
      }
      setMessage({ ok: true, text: "密码修改成功" });
      toast("密码修改成功", "success");
      setForm({ password: "", newPassword: "", newRepeat: "" });
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  const rows: [string, keyof typeof form][] = [
    ["原密码", "password"],
    ["新密码", "newPassword"],
    ["重复新密码", "newRepeat"],
  ];

  return (
    <form id="password-form" onSubmit={submit}>
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          {rows.map(([label, key]) => (
            <tr key={key}>
              <th>{label}</th>
              <td>
                <div>
                  <input
                    type="password"
                    size={20}
                    maxLength={20}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                </div>
              </td>
            </tr>
          ))}
          <tr>
            <th></th>
            <td>
              <button type="submit" className="button active" disabled={submitting}>
                保存
              </button>
              {message && (
                <div className={message.ok ? "hint" : "error"} style={{ marginTop: 8 }}>
                  {message.text}
                </div>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </form>
  );
}

// 绑定邮箱（2026-10-15）：老用户登录名非邮箱，忘记密码时唯一自助找回途径。
// 2026-10-15 张老师改版（提交后不再显示表单）：三态——
//   已验证 → 绿对勾确认态；已发信未验证（刷新回来或刚提交）→ 大绿对勾 + 「一封邮件
//   已发送到 xxx，请登录邮箱进行验证」+ 重发按钮（附「更换邮箱」退回表单）；无草稿 → 表单。
// 重发 = 再次 POST 覆盖草稿并生成新 token（24 小时有效）。

// 发送成功态的大对勾图标（绿圈 + 对勾）
function EmailBindCheck() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true" style={{ display: "block" }}>
      <circle cx="36" cy="36" r="35" fill="#4caf50" opacity="0.14" />
      <circle cx="36" cy="36" r="27" fill="none" stroke="#4caf50" strokeWidth="3" />
      <path
        d="M24 37.5 L32.5 46 L48 28"
        fill="none"
        stroke="#4caf50"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function EmailBindForm({ currentEmail, verified }: { currentEmail: string; verified: boolean }) {
  // 已发过验证邮件（页面刷新回来）或刚提交成功 → 直接进「已发送」态
  const [sentEmail, setSentEmail] = useState<string | null>(currentEmail !== "" && !verified ? currentEmail : null);
  const [email, setEmail] = useState("");
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(mail: string) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: mail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "发送失败");
        return;
      }
      setSentEmail(mail);
      toast("验证邮件已发送", "success");
    } finally {
      setBusy(false);
    }
  }

  if (verified) {
    return (
      <div style={{ padding: "36px 20px", textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <EmailBindCheck />
        </div>
        <p style={{ margin: "18px 0 0", lineHeight: "24px" }}>
          邮箱 <b>{currentEmail}</b> 已验证，忘记密码时可通过邮箱自助找回
        </p>
      </div>
    );
  }

  if (sentEmail) {
    return (
      <div style={{ padding: "36px 20px", textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <EmailBindCheck />
        </div>
        <p style={{ margin: "18px 0 0", lineHeight: "24px" }}>
          一封邮件已发送到 <b>{sentEmail}</b>
          <br />
          请登录邮箱进行验证（24 小时内有效）
        </p>
        <button type="button" className="button active" style={{ marginTop: 20 }} disabled={busy} onClick={() => send(sentEmail)}>
          {busy ? "发送中…" : "重发验证邮件"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSentEmail(null);
            setError("");
          }}
          style={{
            display: "block",
            margin: "14px auto 0",
            border: "none",
            background: "none",
            color: "#75715e",
            fontSize: 13,
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          填错了？更换邮箱
        </button>
        {error && (
          <p className="error" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      id="email-bind-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send(email);
      }}
    >
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          <tr className={focus ? "focus" : ""}>
            <th>邮箱</th>
            <td>
              <div>
                <input
                  type="text"
                  className="email_input"
                  size={30}
                  maxLength={64}
                  placeholder="填写您常用的邮箱"
                  value={email}
                  onFocus={() => setFocus(true)}
                  onBlur={() => setFocus(false)}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <span className="hintMessage">请输入常用邮箱，点击验证邮件中的链接完成绑定</span>
            </td>
          </tr>
          <tr>
            <th></th>
            <td>
              <button type="submit" className="button active" disabled={busy || !email}>
                {busy ? "发送中…" : "发送验证邮件"}
              </button>
              {error && (
                <div className="error" style={{ marginTop: 8 }}>
                  {error}
                </div>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="email_intro">绑定邮箱后，忘记密码可直接通过邮箱自助找回。绑定需点击邮件中的验证链接确认归属。</p>
    </form>
  );
}
