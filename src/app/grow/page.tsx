// 进步榜（移植 2008 版 Ranking_Grow：今日 vs 昨日名次升降）

import { getGrowRanking } from "@/lib/ranksnap";
import { AvatarCell } from "@/components/Cells";
import { Pager } from "@/components/Pager";
import { RankingNav } from "@/components/RankingNav";

export const dynamic = "force-dynamic";
export const metadata = { title: "进步榜 | 扫雷网" };

export default async function GrowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { users, total, pageSize } = await getGrowRanking(page);

  return (
    <div id="page" className="main">
      <RankingNav current="grow" />
      <div id="ranking_header" className="box">
        <h1>进步榜</h1>
        <p className="text">按总计时间排名的日升降幅度排列（每日零点后首个访问生成快照）</p>
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
              上升 <em>{u.delta}</em> 名
            </span>
            <span className="level">
              {u.yesterdayRank} → {u.todayRank}
            </span>
          </div>
        ))}
        {users.length === 0 && <p className="text">快照数据积累两天后开始有进步榜。</p>}
        <Pager base="/grow" params={{}} page={page} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
