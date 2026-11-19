// 账号中心 · 隐私设置（2026-11-18 23:06 张老师：从 /account 页提为独立页）：
// 年龄/星座/关注列表/粉丝列表/新粉丝提醒五个开关 + 黑名单，全放本页。
// 23:28 张老师四改：导航统一筛选器 tabs（AccountHeader）；去「隐私设置」小标题
// 与开关行标签/小字提示（开关文案自释）；黑名单应用小标题样式（原 privacy_title）。
// 双栏 + 右栏玩家卡片（账户中心族同款几何）。

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { AccountHeader } from "@/components/AccountHeader";
import { AccountPrivacySection } from "@/components/AccountPrivacySection";
import { UserPanel } from "@/components/UserCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "隐私设置" };

export default async function AccountPrivacyPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");
  const detail = await getUserDetail(session.uid);
  if (!detail) redirect("/account/login");
  const { user } = detail;
  return (
    <div id="page" className="two_columns">
      <ul id="account_privacy">
        <li className="main">
          <div className="box">
            <AccountHeader active="privacy" />
            <AccountPrivacySection
              flags={{
                ageHidden: user.ageHidden,
                constellationHidden: user.constellationHidden,
                followListHidden: user.followListHidden,
                followerListHidden: user.followerListHidden,
                followNotifyDisabled: user.followNotifyDisabled,
                blocklist: user.followBlocklist,
              }}
            />
          </div>
        </li>
        <li className="sidebar">
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}

