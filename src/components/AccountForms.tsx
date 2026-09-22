// 账号中心表单：修改资料 / 修改密码（移植 forms/ProfileForm、PasswordForm）

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 字段长度限制（移植 UserConfig::INFO_*_LIMIT）
const LIMITS = { qq: 15, nickname: 10, mouse: 30, pad: 30, selfIntro: 50, interest: 50 } as const;

export interface ProfileDefaults {
  qq: string;
  nickname: string;
  mouse: string;
  pad: string;
  selfIntro: string;
  interest: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
}

export function ProfileForm({ defaults }: { defaults: ProfileDefaults }) {
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
          <tr>
            <th>自我介绍</th>
            <td>
              <div>
                <textarea style={{ width: 300 }} rows={4} maxLength={LIMITS.selfIntro} value={form.selfIntro} onChange={set("selfIntro")} />
              </div>
            </td>
          </tr>
          <tr>
            <th>兴趣爱好</th>
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
