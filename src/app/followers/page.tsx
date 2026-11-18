// 我的粉丝列表（2026-11-18 张老师需求 4）：登录用户查看谁关注了我，按关注时间倒序。
// 「新粉丝提醒」系统消息的（去查看）落点即本页。需登录。

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getFollowerList, followingSet } from "@/lib/follow";
import { FollowListBody } from "@/components/FollowListBody";
import { OldPager } from "@/components/OldPager";
import { FOLLOW_LIST_PAGESIZE } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "我的粉丝" };

export default async function FollowersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total } = await getFollowerList(session.uid, page, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="main follow_list_page">
      <div className="box video_box">
        <div className="page_head">
          <h1>我的粉丝</h1>
        </div>
        <FollowListBody rows={rows} viewerId={session.uid} followingIds={followingIds} />
        <OldPager
          base="/followers"
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
