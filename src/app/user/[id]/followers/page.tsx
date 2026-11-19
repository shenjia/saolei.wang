// 他人视角：某玩家的粉丝列表（2026-11-18 张老师需求 4）。
// 隐私：对方 follower_list_hidden=true 时仅本人与管理员可看（管理员 role>=10 放行）。
// 版式（同日 22:32 张老师定）：two_columns 双栏——主栏列表（PageSlider 客户端翻页，
// 他人列表走 /api/follow/list?uid=N 带目标 id）+ 右栏**该玩家**卡片（UserPanel userId=owner）。

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { getFollowerList, followingSet } from "@/lib/follow";
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
  if (!userId) return { title: "粉丝列表" };
  const u = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { chineseName: true },
  });
  return { title: u ? `${u.chineseName}的粉丝` : "粉丝列表" };
}

export default async function UserFollowersPage({
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
    select: { chineseName: true, followerListHidden: true },
  });
  if (!owner) notFound();
  // 隐私闸：隐藏列表仅本人与管理员可看
  const isSelf = session.uid === userId;
  if (owner.followerListHidden && !isSelf && !isManager(session.role)) {
    return (
      <div id="page" className="two_columns">
        <ul id="follow_list">
          <li className="main">
            <div className="box video_box">
              <div className="page_head">
                <h1>{owner.chineseName}的粉丝</h1>
              </div>
              <p className="text fol_private">该用户已隐藏粉丝列表</p>
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
  const { rows, total } = await getFollowerList(userId, 1, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="two_columns">
      <ul id="follow_list">
        <li className="main">
          <div className="box video_box">
            <FollowListFeed
              initial={rows}
              initialTotal={total}
              type="followers"
              title={`${owner.chineseName}的粉丝`}
              listOwner={userId}
              viewerId={session.uid}
              followingIds={followingIds}
            />
          </div>
        </li>
        <li className="sidebar">
          {/* 右栏=该玩家卡片（22:32 张老师定：不是观看者自己的卡片） */}
          <UserPanel userId={userId} cardId="follow_list_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
