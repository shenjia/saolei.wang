// 登录页：微信扫码 | QQ 扫码 | 账号密码（老用户）
// 已登录用户直接回首页

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "登录 - 扫雷网" };

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/");

  return (
    <div id="page" className="main">
      <LoginForm />
    </div>
  );
}
