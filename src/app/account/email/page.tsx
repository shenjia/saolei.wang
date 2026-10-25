// 账号中心 · 绑定邮箱（2026-10-15 新增）
// 老用户登录名非邮箱，忘记密码无法自助找回——绑定并验证邮箱后走邮箱找回。
// 2026-10-15 张老师改版：标题「绑定邮箱」，标题右侧只放「返回」（回 /account），
// 不再挂子导航；侧栏卡片名字去链接（本页右侧不出现任何链接）。

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
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
          <div className="box user_info_cell">
            <h2>{detail.user.chineseName}</h2>
            <p className="title_line">{detail.title}</p>
          </div>
        </li>
      </ul>
    </div>
  );
}
