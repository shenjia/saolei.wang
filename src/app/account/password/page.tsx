// 账号中心 · 修改密码（移植 views/account/password）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AccountHeader } from "@/components/AccountHeader";
import { PasswordForm } from "@/components/AccountForms";
import { UserPanel } from "@/components/UserCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "修改密码" };

export default async function AccountPasswordPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

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
          {/* 与 /account 侧栏同款标准玩家卡片（hideRadar：卡片下只放玩家卡片，2026-10-25） */}
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
