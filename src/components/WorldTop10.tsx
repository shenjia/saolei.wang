// 世界 TOP10（移植 2008 版 Ranking/Top10_World.asp；数据实时抓取 minesweepergame.com，1 天缓存）
// 中国选手行高亮（2008 版 .Ours 语义：站内雷友）

import Link from "next/link";
import { getWorldTop10, WORLD_RANKING_PAGE } from "@/lib/worldtop";

export async function WorldTop10() {
  const data = await getWorldTop10();
  return (
    <div id="world_top" className="box">
      <div className="world_head">
        <h2>世界TOP10</h2>
        <Link href={WORLD_RANKING_PAGE} target="_blank" className="join" title="在 minesweepergame.com 注册并上传录像即可加入世界排行">
          如何加入
        </Link>
      </div>
      {data ? (
        <>
          <table cellPadding={0} cellSpacing={0}>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Name</th>
                <th>Beg</th>
                <th>Int</th>
                <th>Exp</th>
                <th>Sum</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.rank} className={r.flag === "china" ? "ours" : ""}>
                  <td className="rank">
                    No.&nbsp;<em>{r.rank}</em>
                  </td>
                  <td className="name">{r.name}</td>
                  <td className="t">{r.beg}</td>
                  <td className="t">{r.int}</td>
                  <td className="t">{r.exp}</td>
                  <td className="sum">{Math.round(parseFloat(r.sum))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="world_foot">
            <Link href={WORLD_RANKING_PAGE} target="_blank">
              点击查看完整世界排行
            </Link>
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
