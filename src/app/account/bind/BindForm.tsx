"use client";

// 绑定微信 / QQ（二选一，扫码即绑定到当前登录账号）

import { useState } from "react";

export default function BindForm({ error }: { error: string }) {
  const [tab, setTab] = useState<"wechat" | "qq">("wechat");

  return (
    <div id="account_bind" className="box">
      <h1>绑定微信或 QQ</h1>
      <p className="hint" style={{ marginTop: 0 }}>
        为保障账号安全，老用户需绑定微信或 QQ 后才能继续使用。今后扫码即可登录。
      </p>
      <div className="tabs auth_tabs">
        {tab === "wechat" ? (
          <em className="active">微信扫码</em>
        ) : (
          <a href="#" onClick={(e) => (e.preventDefault(), setTab("wechat"))}>
            微信扫码
          </a>
        )}
        {tab === "qq" ? (
          <em className="active">QQ 扫码</em>
        ) : (
          <a href="#" onClick={(e) => (e.preventDefault(), setTab("qq"))}>
            QQ 扫码
          </a>
        )}
      </div>

      {tab === "wechat" ? (
        <div className="auth_qr">
          <iframe src="/api/auth/wechat/qr" title="微信扫码绑定" />
          <p className="hint">打开微信「扫一扫」，扫码后确认即可完成绑定</p>
        </div>
      ) : (
        <div className="auth_qr">
          <p className="hint">点击下方按钮，跳转 QQ 授权页完成绑定</p>
          <a className="auth_button qq" href="/api/auth/qq">
            绑定 QQ
          </a>
        </div>
      )}

      {error === "taken" && <p className="auth_error">该微信/QQ 已绑定到其他账号，请换一个试试</p>}
    </div>
  );
}
