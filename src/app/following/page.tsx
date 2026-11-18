// 我的关注列表（2026-11-18 张老师需求 4）：登录用户查看自己关注了谁，按关注时间倒序。
// 需登录（redirect /account/login）；翻页 OldPager（?page= 服务端分页）。

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getFollowingList, followingSet } from "@/lib/follow";
import { FollowListBody } from "@/components/FollowListBody";
import { OldPager } from "@/components/OldPager";
import { FOLLOW_LIST_PAGESIZE } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "我的关注" };

export default async function FollowingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total } = await getFollowingList(session.uid, page, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="main follow_list_page">
      <div className="box video_box">
        <div className="page_head">
          <h1>我的关注</h1>
        </div>
        <FollowListBody rows={rows} viewerId={session.uid} followingIds={followingIds} />
        <OldPager
          base="/following"
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
