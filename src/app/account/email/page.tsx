// 账号中心 · 绑定邮箱（2026-10-15 新增）
// 老用户登录名非邮箱，忘记密码无法自助找回——绑定并验证邮箱后走邮箱找回。

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { AccountHeader } from "@/components/AccountHeader";
import { EmailBindForm } from "@/components/AccountForms";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "绑定邮箱" };

export default async function AccountEmailPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const [detail, auth] = await Promise.all([
    getUserDetail(session.uid),
    prisma.userAuth.findUnique({
      where: { id: BigInt(session.uid) },
      select: { email: true, emailVerified: true },
    }),
  ]);
  if (!detail) redirect("/account/login");

  return (
    <div id="page" className="two_columns">
      <ul id="account_email">
        <li className="main">
          <div className="box">
            <AccountHeader />
            <EmailBindForm currentEmail={auth?.email ?? ""} verified={Number(auth?.emailVerified ?? 0) > 0} />
          </div>
        </li>
        <li className="sidebar">
          <div className="box user_info_cell">
            <h2>
              <Link href={`/user/${detail.user.id}`}>{detail.user.chineseName}</Link>
            </h2>
            <p className="title_line">{detail.title}</p>
          </div>
        </li>
      </ul>
    </div>
  );
}
