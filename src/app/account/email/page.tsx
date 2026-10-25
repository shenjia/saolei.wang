// 账号中心 · 绑定邮箱（2026-10-15 新增）
// 老用户登录名非邮箱，忘记密码无法自助找回——绑定并验证邮箱后走邮箱找回。
// 2026-10-15 张老师改版：标题「绑定邮箱」，标题右侧只放「返回」（回 /account），
// 不再挂子导航；侧栏卡片名字去链接（本页右侧不出现任何链接）。
// 2026-10-25：侧栏统一为标准玩家卡片（UserPanel，与 /account 一致，hideRadar）。

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { EmailBindForm } from "@/components/AccountForms";
import { UserPanel } from "@/components/UserCard";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "绑定邮箱" };

export default async function AccountEmailPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const [auth] = await Promise.all([
    prisma.userAuth.findUnique({
      where: { id: BigInt(session.uid) },
      select: { email: true, emailVerified: true },
    }),
  ]);

  return (
    <div id="page" className="two_columns">
      <ul id="account_email">
        <li className="main">
          <div className="box">
            <div className="nav">
              <h1>绑定邮箱</h1>
              <ul className="email_back">
                <li>
                  <Link href="/account">返回</Link>
                </li>
              </ul>
            </div>
            <hr />
            <EmailBindForm currentEmail={auth?.email ?? ""} verified={Number(auth?.emailVerified ?? 0) > 0} />
          </div>
        </li>
        <li className="sidebar">
          {/* 标准玩家卡片（名字带链接去用户主页，2026-10-25 与 /account 统一后恢复常规卡片口径） */}
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
