// 账号中心 · 修改资料（移植 views/account/profile）

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { AccountHeader } from "@/components/AccountHeader";
import { ProfileForm, type AvatarSlot } from "@/components/AccountForms";
import { AVATAR_REVIEW_STATUS, resolveAvatarUrl } from "@/lib/avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "修改资料 | 扫雷网" };

export default async function AccountProfilePage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const uid = BigInt(session.uid);
  const [detail, info, me, latestAvatar] = await Promise.all([
    getUserDetail(session.uid),
    prisma.userInfo.findUnique({ where: { id: uid } }),
    prisma.user.findUnique({ where: { id: uid }, select: { avatar: true } }),
    // 最新一条头像审核记录：待审 / 驳回时才需要提示（自动放行的无需提示）
    prisma.avatarReview.findFirst({ where: { user: uid }, orderBy: { id: "desc" } }),
  ]);
  if (!detail) redirect("/account/login");

  const avatarValue = me?.avatar ?? "";
  const avatarSlot: AvatarSlot = {
    currentUrl: resolveAvatarUrl(
      avatarValue,
      avatarValue === "1" ? `/images/player/${session.uid}.jpg` : "/images/player/no.jpg",
    ),
    pendingUrl:
      latestAvatar?.status === AVATAR_REVIEW_STATUS.PENDING ? latestAvatar.filepath : null,
    pendingReason:
      latestAvatar?.status === AVATAR_REVIEW_STATUS.PENDING ? latestAvatar.reason : undefined,
    rejected:
      latestAvatar?.status === AVATAR_REVIEW_STATUS.REJECTED
        ? { reason: latestAvatar.reason || "未通过管理员审核" }
        : null,
  };

  const birthday = Number(info?.birthday ?? 0);
  const d = birthday > 0 ? new Date(birthday * 1000) : null;

  return (
    <div id="page" className="two_columns">
      <ul id="account_profile">
        <li className="main">
          <div className="box">
            <AccountHeader />
            <ProfileForm
              avatarSlot={avatarSlot}
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
