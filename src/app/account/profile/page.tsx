// 账号中心 · 修改资料（移植 views/account/profile）

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { AccountHeader } from "@/components/AccountHeader";
import { ProfileForm } from "@/components/AccountForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "修改资料 | 扫雷网" };

export default async function AccountProfilePage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const [detail, info] = await Promise.all([
    getUserDetail(session.uid),
    prisma.userInfo.findUnique({ where: { id: BigInt(session.uid) } }),
  ]);
  if (!detail) redirect("/account/login");

  const birthday = Number(info?.birthday ?? 0);
  const d = birthday > 0 ? new Date(birthday * 1000) : null;

  return (
    <div id="page" className="two_columns">
      <ul id="account_profile">
        <li className="main">
          <div className="box">
            <AccountHeader />
            <ProfileForm
              defaults={{
                selfIntro: info?.selfIntro ?? "",
                interest: info?.interest ?? "",
                qq: info?.qq ?? "",
                nickname: info?.nickname ?? "",
                mouse: info?.mouse ?? "",
                pad: info?.pad ?? "",
                birthYear: d ? d.getFullYear() : 0,
                birthMonth: d ? d.getMonth() + 1 : 0,
                birthDay: d ? d.getDate() : 0,
              }}
            />
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
