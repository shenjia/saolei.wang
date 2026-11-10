// 账号中心 · 修改资料（移植 views/account/profile）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { AccountHeader } from "@/components/AccountHeader";
import { ProfileForm, type AvatarSlot } from "@/components/AccountForms";
import { UserPanel } from "@/components/UserCard";
import { AVATAR_REVIEW_STATUS, resolveAvatarUrl, isDefaultAvatar } from "@/lib/avatar";
import { LEGACY_DEFAULT_BIRTHDAY } from "@/lib/birth";

export const dynamic = "force-dynamic";
export const metadata = { title: "修改资料" };

export default async function AccountProfilePage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const uid = BigInt(session.uid);
  const [detail, info, me, latestAvatar, userRow] = await Promise.all([
    getUserDetail(session.uid),
    prisma.userInfo.findUnique({ where: { id: uid } }),
    prisma.user.findUnique({ where: { id: uid }, select: { avatar: true } }),
    // 最新一条头像审核记录：待审 / 驳回时才需要提示（自动放行的无需提示）
    prisma.avatarReview.findFirst({ where: { user: uid }, orderBy: { id: "desc" } }),
    // 地区存 user 表（2026-10-25 张老师要求：修改资料可更换地区）
    prisma.user.findUnique({ where: { id: uid }, select: { area: true } }),
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
    // 无头像：军衔制下按性别给军装默认头像（2026-11-11）；有真实头像时绝不传
    defaultSex: isDefaultAvatar(avatarValue) ? detail.user.sex : undefined,
  };

  const birthday = Number(info?.birthday ?? 0);
  // 1980-01-01 是旧站默认值（未填生日的用户被批量写入，2026-11-03 张老师确认）：
  // 表单按未填处理——三个下拉显示空白，而不是 1980/1/1
  const d =
    birthday > 0 && birthday !== LEGACY_DEFAULT_BIRTHDAY ? new Date(birthday * 1000) : null;

  return (
    <div id="page" className="two_columns">
      <ul id="account_profile">
        <li className="main">
          <div className="box">
            <AccountHeader />
            <ProfileForm
              avatarSlot={avatarSlot}
              defaults={{
                area: userRow?.area ?? "",
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
          {/* 与 /account 侧栏同款标准玩家卡片（hideRadar：卡片下只放玩家卡片，2026-10-25） */}
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
