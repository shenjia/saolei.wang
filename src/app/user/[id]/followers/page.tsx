// 他人视角：某玩家的粉丝列表（2026-11-18 张老师需求 4）。
// 隐私：对方 follower_list_hidden=true 时仅本人与管理员可看（10-16 封禁语义沿用
// status 判定无需额外处理；管理员 role>=10 放行）。/followers 与 /following
// 是登录用户的自己的列表（首页落点）；本页挂在用户主页路径下供他人浏览。

import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getFollowerList, followingSet } from "@/lib/follow";
import { prisma } from "@/lib/db";
import { FollowListBody } from "@/components/FollowListBody";
import { OldPager } from "@/components/OldPager";
import { FOLLOW_LIST_PAGESIZE, isManager } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  void params;
  return { title: "粉丝列表" };
}

import type { Metadata } from "next";

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
      <div id="page" className="main follow_list_page">
        <div className="box video_box">
          <div className="page_head">
            <h1>{owner.chineseName}的粉丝</h1>
          </div>
          <p className="text fol_private">该用户已隐藏粉丝列表</p>
        </div>
      </div>
    );
  }
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total } = await getFollowerList(userId, page, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="main follow_list_page">
      <div className="box video_box">
        <div className="page_head">
          <h1>{owner.chineseName}的粉丝</h1>
        </div>
        <FollowListBody rows={rows} viewerId={session.uid} followingIds={followingIds} />
        <OldPager
          base={`/user/${userId}/followers`}
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
