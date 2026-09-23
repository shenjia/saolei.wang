// 排行榜：级别（总计/初级/中级/高级）× 排序（时间/3BV/s）× 模式（普通/NF）
// （移植 views/ranking/index + 2008 版 Ranking_NF）

import Link from "next/link";
import { getRanking } from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { LEVELS, LEVEL_NAMES, ORDERS, type Level, type Order } from "@/lib/config";
import { AvatarCell, Score3bvs, ScoreTime, TitleBadge } from "@/components/Cells";
import { Pager, Tabs } from "@/components/Pager";

export const dynamic = "force-dynamic";

function parseLevel(v?: string): Level {
  return (LEVELS as readonly string[]).includes(v ?? "") ? (v as Level) : "sum";
}
function parseOrder(v?: string): Order {
  return (ORDERS as readonly string[]).includes(v ?? "") ? (v as Order) : "time";
}

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const level = parseLevel(sp.level);
  const order = parseOrder(sp.order);
  const nf = sp.nf === "1";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const { users, total, pageSize } = await getRanking(level, order, page, nf);
  const session = await getSession();
  const params = { level, order, ...(nf ? { nf: "1" } : {}) };

  return (
    <div id="page" className="main">
      <div id="ranking_header" className="box">
        <h1>排行榜{nf && "（NF 无标雷）"}</h1>
        {session && (
          <Link
            className="button active"
            href={`/ranking/whereami?id=${session.uid}&level=${level}&order=${order}${nf ? "&nf=1" : ""}`}
          >
            我在哪里?
          </Link>
        )}
        <Link className="button" href="/user/random" target="_blank">
          随机串门
        </Link>
        <Link className="button" href="/grow">
          进步榜
        </Link>
        <Link className="button" href="/click">
          人气榜
        </Link>
        <div className="filters">
          <Tabs
            base="/ranking"
            params={params}
            name="nf"
            current={nf ? "1" : "0"}
            options={[
              ["0", "普通榜"],
              ["1", "NF 无标雷"],
            ]}
          />
          <Tabs
            base="/ranking"
            params={params}
            name="level"
            current={level}
            options={[
              ["sum", "总计"],
              ["beg", "初级"],
              ["int", "中级"],
              ["exp", "高级"],
            ]}
          />
          <Tabs
            base="/ranking"
            params={params}
            name="order"
            current={order}
            options={[
              ["time", "按成绩排列"],
              ["3bvs", "按3BV/s排列"],
            ]}
          />
        </div>
      </div>
      <div id="user_list" className="ranking_list">
        {users.map((u) => {
          // 总计链接到用户主页，单级别链接到对应录像（移植 ranking/index）
          const href = level === "sum" ? `/user/${u.id}` : `/video/${u.videoId}`;
          return (
            <Link key={u.id} href={href} target="_blank" className="user_cell_link" id={`id_${u.id}`}>
              <div className="user_cell box">
                <span className="rank">
                  No.<em>{u.rank}</em>
                </span>
                <span className="user">
                  <AvatarCell id={u.id} name={u.chineseName} sex={u.sex} />
                </span>
                <TitleBadge title={u.title} />
                <span className="level">{LEVEL_NAMES[level]}</span>
                {order === "time" ? (
                  <ScoreTime score={u.score} date={u.date} />
                ) : (
                  <Score3bvs score={u.score} date={u.date} />
                )}
              </div>
            </Link>
          );
        })}
        <Pager base="/ranking" params={params} page={page} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
