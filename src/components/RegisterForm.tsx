// 注册表单（2013 版 table.form 行为复刻）：
// - 行 class 驱动 legacy-2013.css：focus 行显示 hint（绿）、error 行显示 errorMessage（红）
// - 性别用 .radioButton 雪碧图 span（/images/form/radioButton.png），与 2013 版一致
// - 提交走 /api/auth/register，字段错误按行标红；成功后切换为「注册成功」视图（2008 Register_OK 骨架）
"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AREA_LIST } from "@/lib/config";

type FieldKey = "email" | "password" | "confirm" | "chineseName" | "englishName";

const TEXT_FIELDS: { key: FieldKey; label: string; type: "text" | "password"; hint: ReactNode }[] = [
  {
    key: "email",
    label: "电子邮箱",
    type: "text",
    hint: (
      <>
        请输入常用邮箱作为登录名<em>（注册后不可更改）</em>
      </>
    ),
  },
  { key: "password", label: "登录密码", type: "password", hint: "请输入 6~20 位密码" },
  { key: "confirm", label: "重复密码", type: "password", hint: "请再次输入密码" },
  {
    key: "chineseName",
    label: "中文姓名",
    type: "text",
    hint: (
      <>
        本站要求实名注册<em>（注册后不可更改）</em>
      </>
    ),
  },
  {
    key: "englishName",
    label: "姓名拼音",
    type: "text",
    hint: (
      <>
        字与字空格分隔、首字母大写，如：<em>Zhang Shen Jia</em>
      </>
    ),
  },
];

export default function RegisterForm() {
  const [values, setValues] = useState<Record<FieldKey, string>>({
    email: "",
    password: "",
    confirm: "",
    chineseName: "",
    englishName: "",
  });
  const [sex, setSex] = useState(1);
  const [area, setArea] = useState<(typeof AREA_LIST)[number]>("北京");
  const [focus, setFocus] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fatal, setFatal] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ chineseName: string; englishName: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 前端预检：仅挡最常见手误，权威校验在服务端
    if (values.password !== values.confirm) {
      setErrors({ confirm: "两次输入的密码不一致！" });
      return;
    }
    setBusy(true);
    setErrors({});
    setFatal("");
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, sex, area }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.errors) setErrors(data.errors);
      else setFatal(data.error ?? "注册失败，请稍候再试！");
      return;
    }
    setDone({ chineseName: data.chineseName, englishName: data.englishName });
  }

  // ---------- 注册成功（2008 版 Register_OK.asp 骨架） ----------
  if (done) {
    return (
      <div className="reg_ok">
        <div className="flash">
          {done.chineseName}（{done.englishName}），注册成功了，恭喜您！
        </div>
        <p>
          您已自动登录。上传录像前，请先在 Minesweeper Arbiter 中按 <b>F5</b>{" "}
          设置您的录像标识文字（建议使用姓名拼音，如 <b>{done.englishName}</b>），
          上传时系统会按标识文字核对录像归属。
        </p>
        <Link className="button active" href="/page/help">
          如何加入排行
        </Link>
        <Link className="button" href="/">
          返回首页
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          {TEXT_FIELDS.map((f) => (
            <tr
              key={f.key}
              className={[focus === f.key ? "focus" : "", errors[f.key] ? "error" : ""]
                .filter(Boolean)
                .join(" ")}
            >
              <th>{f.label}</th>
              <td>
                <div>
                  <input
                    type={f.type}
                    value={values[f.key]}
                    onFocus={() => setFocus(f.key)}
                    onBlur={() => setFocus("")}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                </div>
                <span className="hintMessage">{f.hint}</span>
                <span className="errorMessage">{errors[f.key]}</span>
              </td>
            </tr>
          ))}
          <tr>
            <th>性　　别</th>
            <td className="middle">
              <span
                className={"radioButton" + (sex === 1 ? " checked" : "")}
                onClick={() => setSex(1)}
              >
                男
              </span>
              <span
                className={"radioButton" + (sex === 0 ? " checked" : "")}
                onClick={() => setSex(0)}
              >
                女
              </span>
            </td>
          </tr>
          <tr className={errors.area ? "error" : ""}>
            <th>所在地区</th>
            <td className="middle">
              <div>
                <select
                  value={area}
                  onChange={(e) => setArea(e.target.value as (typeof AREA_LIST)[number])}
                >
                  {AREA_LIST.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <span className="errorMessage">{errors.area}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="down" />
      <button className="button active" type="submit" disabled={busy}>
        {busy ? "提交中…" : "完成注册"}
      </button>
      <span className="reg_login">
        已有账号？<Link href="/account/login">马上登录</Link>
      </span>
      {fatal && <p className="error">{fatal}</p>}
    </form>
  );
}
