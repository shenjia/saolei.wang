// 登录页：微信扫码 | QQ 扫码 | 账号密码（老用户）
// 已登录用户直接回首页；面板与全局登录浮窗共用（components/LoginPanel.tsx）
// 2026-10-15 修复：?next= 此前无人消费，登录后一律回首页——邮箱验证链接
// （/account/email/verify?token=…）经未登录 307 跳来后 token 被吞，验证永远完不成。
// 只放行站内路径（以单个 / 开头，排除 // 与外部 URL）。

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LoginPanel from "@/components/LoginPanel";

export const dynamic = "force-dynamic";

export const metadata = { title: "登录" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (session) redirect("/");

  const sp = await searchParams;
  const rawNext = sp.next ?? "";
  const nextPath = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "";

  return (
    <div id="page" className="main">
      {/* 玻璃卡容器与浮窗共用 id（globals.css #account_login），2026-09-24 玻璃层改版 */}
      <div id="account_login">
        <LoginPanel initialError={sp.error ?? ""} nextPath={nextPath} />
      </div>
    </div>
  );
}
