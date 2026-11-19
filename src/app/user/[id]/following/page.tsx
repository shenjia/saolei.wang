// 他人视角：某玩家的关注列表（2026-11-18 张老师需求 4）。
// 隐私：对方 follow_list_hidden=true 时仅本人与管理员可看，同粉丝列表口径。
// 版式（同日 22:32 张老师定）：two_columns 双栏——主栏列表（PageSlider）+ 右栏该玩家卡片。

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { getFollowingList, followingSet } from "@/lib/follow";
import { prisma } from "@/lib/db";
import { FollowListFeed } from "@/components/FollowListFeed";
import { UserPanel } from "@/components/UserCard";
import { FOLLOW_LIST_PAGESIZE, isManager } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = parseInt((await params).id, 10) || 0;
  if (!userId) return { title: "关注列表" };
  const u = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { chineseName: true },
  });
  return { title: u ? `${u.chineseName}的关注` : "关注列表" };
}

export default async function UserFollowingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const userId = parseInt((await params).id, 10);
  if (!userId) notFound();
  const session = await getSession();
  if (!session) redirect("/account/login");
  const owner = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { chineseName: true, followListHidden: true },
  });
  if (!owner) notFound();
  const isSelf = session.uid === userId;
  if (owner.followListHidden && !isSelf && !isManager(session.role)) {
    return (
      <div id="page" className="two_columns">
        <ul id="follow_list">
          <li className="main">
            <div className="box video_box">
              <div className="page_head">
                <h1>{owner.chineseName}的关注</h1>
              </div>
              <p className="text fol_private">该用户已隐藏关注列表</p>
            </div>
          </li>
          <li className="sidebar">
            <UserPanel userId={userId} cardId="follow_list_user_card" hideRadar />
          </li>
        </ul>
      </div>
    );
  }
  await searchParams;
  const { rows, total } = await getFollowingList(userId, 1, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="two_columns">
      <ul id="follow_list">
        <li className="main">
          <div className="box video_box">
            <FollowListFeed
              initial={rows}
              initialTotal={total}
              type="following"
              title={`${owner.chineseName}的关注`}
              listOwner={userId}
              viewerId={session.uid}
              followingIds={followingIds}
            />
          </div>
        </li>
        <li className="sidebar">
          <UserPanel userId={userId} cardId="follow_list_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
