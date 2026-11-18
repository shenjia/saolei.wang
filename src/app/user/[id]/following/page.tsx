// 他人视角：某玩家的关注列表（2026-11-18 张老师需求 4）。
// 隐私：对方 follow_list_hidden=true 时仅本人与管理员可看，同粉丝列表口径。

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { getFollowingList, followingSet } from "@/lib/follow";
import { prisma } from "@/lib/db";
import { FollowListBody } from "@/components/FollowListBody";
import { OldPager } from "@/components/OldPager";
import { FOLLOW_LIST_PAGESIZE, isManager } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "关注列表" };
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
      <div id="page" className="main follow_list_page">
        <div className="box video_box">
          <div className="page_head">
            <h1>{owner.chineseName}的关注</h1>
          </div>
          <p className="text fol_private">该用户已隐藏关注列表</p>
        </div>
      </div>
    );
  }
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total } = await getFollowingList(userId, page, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="main follow_list_page">
      <div className="box video_box">
        <div className="page_head">
          <h1>{owner.chineseName}的关注</h1>
        </div>
        <FollowListBody rows={rows} viewerId={session.uid} followingIds={followingIds} />
        <OldPager
          base={`/user/${userId}/following`}
          params={{}}
          page={page}
          total={total}
          pageSize={FOLLOW_LIST_PAGESIZE}
          unit="位"
        />
      </div>
    </div>
  );
}
