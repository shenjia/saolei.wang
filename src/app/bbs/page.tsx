// 论坛首页（移植 2008 版 BBS/Index.asp + BBS_All 等列表）
// 板块 tab + 排序 + 精华过滤 + 分页；置顶帖优先

import Link from "next/link";
import { BBS_BOARDS, BBS_BOARD_NAMES, BBS_ORDERS, getPostList, type BbsOrder } from "@/lib/bbs";
import { getSession } from "@/lib/auth";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { Pager, Tabs } from "@/components/Pager";

export const dynamic = "force-dynamic";
export const metadata = { title: "论坛 | 扫雷网" };

function parseOrder(v?: string): BbsOrder {
  return v && v in BBS_ORDERS ? (v as BbsOrder) : "reply";
}

export default async function BbsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const board = sp.board !== undefined && BBS_BOARD_NAMES[parseInt(sp.board, 10)] !== undefined
    ? parseInt(sp.board, 10)
    : undefined;
  const order = parseOrder(sp.order);
  const nice = sp.nice === "1";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [{ posts, total, pageSize }, session] = await Promise.all([
    getPostList({ board, order, nice: nice || undefined, page }),
    getSession(),
  ]);
  const params: Record<string, string> = {
    ...(board !== undefined ? { board: String(board) } : {}),
    order,
    ...(nice ? { nice: "1" } : {}),
  };

  return (
    <div id="page" className="main">
      <div id="ranking_header" className="box">
        <h1>论坛</h1>
        {session && (
          <Link className="button active" href="/bbs/post">
            发布主题
          </Link>
        )}
        <Link className="button" href="/page/help/bbs" target="_blank">
          管理条例
        </Link>
        <div className="filters">
          <Tabs
            base="/bbs"
            params={params}
            name="board"
            current={board === undefined ? "all" : String(board)}
            options={[
              ["all", "全部"],
              ...BBS_BOARDS.map((b) => [String(b.id), b.name] as [string, string]),
            ]}
          />
          <Tabs
            base="/bbs"
            params={params}
            name="order"
            current={order}
            options={Object.entries(BBS_ORDERS) as [string, string][]}
          />
          <Tabs
            base="/bbs"
            params={params}
            name="nice"
            current={nice ? "1" : "0"}
            options={[
              ["0", "全部主题"],
              ["1", "只看精华"],
            ]}
          />
        </div>
      </div>
      <div className="box">
        <table cellPadding={0} cellSpacing={0} className="table full bbs_list">
          <thead>
            <tr>
              <th style={{ width: 90 }}>分类</th>
              <th>主题</th>
              <th style={{ width: 170 }}>作者</th>
              <th style={{ width: 110 }}>回复/点击</th>
              <th style={{ width: 100 }}>最后更新</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td>
                  {board === undefined && <span className="board_tag">【{BBS_BOARD_NAMES[p.board]}】</span>}
                </td>
                <td>
                  <Link className="bbs_title" href={`/bbs/${p.id}`} target="_blank">
                    {p.title}
                  </Link>
                  {p.isNice && (
                    <span className="bbs_star" data-tip="精华">
                      ★
                    </span>
                  )}
                  {p.isTop && (
                    <span className="bbs_top" data-tip="置顶">
                      ▲
                    </span>
                  )}
                  {p.isLocked && <span className="bbs_flag locked">锁</span>}
                </td>
                <td className="user">
                  {p.author && (
                    <>
                      <Link href="/world" target="_blank" title="点击查看称号说明" className="bbs_oldtitle">
                        [<span style={{ color: p.author.old.color }}>{p.author.old.name}</span>]
                      </Link>{" "}
                      <Link href={`/user/${p.author.id}`} target="_blank">
                        {p.author.chineseName}
                      </Link>
                      <span className={`gender ${p.author.sex ? "male" : "female"} small`}></span>
                    </>
                  )}
                </td>
                <td>
                  <em>{p.replies}</em>/{p.clicks}
                </td>
                <td className="time">{timeOpposite(p.lastReplyTime, TIME_NEVER)}</td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr>
                <td colSpan={5}>还没有主题，来发第一帖吧。</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager base="/bbs" params={params} page={page} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
