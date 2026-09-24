// 世界 TOP100（移植 2008 版 Ranking/Top10_World.asp；数据实时抓取 minesweepergame.com，1 天缓存）
// 2026-09-23 晚从 TOP10 扩充到 TOP100（张老师要求）；中国选手行高亮（2008 版 .Ours 语义：站内雷友）
// 2026-09-24：默认只显示前 15 条，下面「加载更多」增量展开（张老师要求），表格交互在 WorldTop100Table

import Link from "next/link";
import { getWorldTop100, WORLD_RANKING_PAGE } from "@/lib/worldtop";
import { RankingNav } from "@/components/RankingNav";
import { WorldTop100Table } from "@/components/WorldTop100Table";

export async function WorldTop100() {
  const data = await getWorldTop100();
  return (
    <div id="world_top" className="box ranking_box">
      <div className="page_head">
        <h1 className="page_title">世界排行</h1>
        <RankingNav current="world" />
      </div>
      {data ? (
        <>
          <WorldTop100Table rows={data.rows} />
          <div className="world_foot">
            <span className="world_foot_links">
              <Link href={WORLD_RANKING_PAGE} target="_blank">
                点击查看完整世界排行
              </Link>
              <Link
                href={WORLD_RANKING_PAGE}
                target="_blank"
                className="join"
                title="在 minesweepergame.com 注册并上传录像即可加入世界排行"
              >
                如何加入
              </Link>
            </span>
            <span>
              更新时间：
              {(() => {
                const d = new Date(data.fetchedAt);
                return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
              })()}
            </span>
          </div>
        </>
      ) : (
        <p className="world_fail">暂时无法获取世界排行，请稍后再试。</p>
      )}
    </div>
  );
}
