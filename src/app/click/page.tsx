// 人气榜（移植 2008 版 Ranking_Click：总人气排序 + 今日人气）

import { getClickRanking } from "@/lib/star";
import { AvatarCell } from "@/components/Cells";
import { Pager } from "@/components/Pager";

export const dynamic = "force-dynamic";
export const metadata = { title: "人气榜 | 扫雷网" };

export default async function ClickRankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { users, total, pageSize } = await getClickRanking(page);

  return (
    <div id="page" className="main">
      <div id="ranking_header" className="box">
        <h1>人气榜</h1>
      </div>
      <div id="user_list" className="ranking_list">
        {users.map((u) => (
          <div key={u.id} className="user_cell box">
            <span className="rank">
              No.<em>{u.rank}</em>
            </span>
            <span className="user">
              <AvatarCell id={u.id} name={u.chineseName} sex={u.sex} link />
            </span>
            <span className="score">
              人气 <em>{u.total}</em>
              {u.today > 0 && <span>（今日 +{u.today}）</span>}
            </span>
          </div>
        ))}
        <Pager base="/click" params={{}} page={page} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
