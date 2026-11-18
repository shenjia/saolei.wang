// 我的关注列表（2026-11-18 张老师需求 4）：登录用户查看自己关注了谁，按关注时间倒序。
// 版式（同日 22:32 张老师定）：two_columns 双栏——主栏列表（标准翻页控件 PageSlider），
// 右栏标准玩家卡片（UserPanel）。需登录（redirect /account/login）。

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getFollowingList, followingSet } from "@/lib/follow";
import { FollowListFeed } from "@/components/FollowListFeed";
import { UserPanel } from "@/components/UserCard";
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
  await searchParams; // 翻页由客户端 PageSlider 承担，URL 参数不再消费（保留签名兼容）
  const { rows, total } = await getFollowingList(session.uid, 1, FOLLOW_LIST_PAGESIZE);
  const followingIds = [...(await followingSet(session.uid, rows.map((r) => r.id)))];
  return (
    <div id="page" className="two_columns">
      <ul id="follow_list">
        <li className="main">
          <div className="box video_box">
            <div className="page_head">
              <h1>我的关注</h1>
            </div>
            <FollowListFeed
              initial={rows}
              initialTotal={total}
              type="following"
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
