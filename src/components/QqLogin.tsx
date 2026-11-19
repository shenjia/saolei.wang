"use client";

// QQ 弹窗登录（2026-10-25 张老师定交互，参照爱给网）：
// 登录框内放企鹅图标，点击 window.open 弹出 QQ 官方授权小窗，
// 授权完成后小窗自闭、主窗口跳转（关窗页由 /api/auth/qq/callback 输出）。
// 图标直接用张老师提供的官方 QQ 剪影图（public/images/qq-login.png，
// 原图企鹅是透明镂空，已用洪泛填充为亮灰 #c8ccd2——脚本处理勿手改）。

/* eslint-disable @next/next/no-img-element -- 单色小图标无需 next/image 优化 */
export function QqPenguinIcon({ size = 32 }: { size?: number }) {
  return (
    <img
      src="/images/qq-login.png"
      width={size}
      height={size}
      alt="QQ 登录"
      style={{ display: "block", borderRadius: "50%" }}
    />
  );
}

// 居中弹出 QQ 授权窗；?popup=1 让回调知道走「关窗 + 主窗跳转」模式
// next：授权成功后主窗口回跳地址（账户管理页绑定入口传 /account，绑完回到原页）
export function openQqLoginPopup(next?: string) {
  const w = 720;
  const h = 560;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const url = `/api/auth/qq?popup=1${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  window.open(
    url,
    "saolei_qq_login",
    `width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)},menubar=no,toolbar=no,location=no,status=no`
  );
}

// 账户管理页 QQ 行后的「（绑定QQ）」入口（2026-10-25 张老师定：
// 不强制绑定，想绑的用户在账户管理页手动点；括号由 .bind_email_btn 的 ::before/::after 提供）
export function QqBindLink() {
  return (
    <a
      href="#"
      className="bind_email_btn"
      onClick={(e) => {
        e.preventDefault();
        openQqLoginPopup("/account");
      }}
    >
      绑定QQ
    </a>
  );
}
