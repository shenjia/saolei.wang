// 账号中心 · 修改密码（移植 views/account/password）

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { AccountHeader } from "@/components/AccountHeader";
import { PasswordForm } from "@/components/AccountForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "修改密码 | 扫雷网" };

export default async function AccountPasswordPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const detail = await getUserDetail(session.uid);
  if (!detail) redirect("/account/login");

  return (
    <div id="page" className="two_columns">
      <ul id="account_password">
        <li className="main">
          <div className="box">
            <AccountHeader />
            <PasswordForm />
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
