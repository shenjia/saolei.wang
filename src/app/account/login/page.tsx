// 登录页：微信扫码 | QQ 扫码 | 账号密码（老用户）
// 已登录用户直接回首页；面板与全局登录浮窗共用（components/LoginPanel.tsx）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LoginPanel from "@/components/LoginPanel";

export const dynamic = "force-dynamic";

export const metadata = { title: "登录 - 扫雷网" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (session) redirect("/");

  const sp = await searchParams;

  return (
    <div id="page" className="main">
      <LoginPanel initialError={sp.error ?? ""} />
    </div>
  );
}
