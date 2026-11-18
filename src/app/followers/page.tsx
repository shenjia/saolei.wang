// 我的粉丝列表（2026-11-18 张老师需求 4）：登录用户查看谁关注了我，按关注时间倒序。
// 「新粉丝提醒」系统消息的（去查看）落点即本页。需登录。
// 版式（同日 22:32 张老师定）：two_columns 双栏——主栏列表（PageSlider）+ 右栏玩家卡片。

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getFollowerList, followingSet } from "@/lib/follow";
import { FollowListFeed } from "@/components/FollowListFeed";
import { UserPanel } from "@/components/UserCard";
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
  await searchParams;
  const { rows, total } = await getFollowerList(session.uid, 1, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="two_columns">
      <ul id="follow_list">
        <li className="main">
          <div className="box video_box">
            <div className="page_head">
              <h1>我的粉丝</h1>
            </div>
            <FollowListFeed
              initial={rows}
              initialTotal={total}
              type="followers"
              viewerId={session.uid}
              followingIds={followingIds}
            />
          </div>
        </li>
        <li className="sidebar">
          <UserPanel userId={session.uid} cardId="follow_list_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
