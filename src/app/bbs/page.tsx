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
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 60 }}>
                  {p.isTop && <em className="bbs_flag">置顶</em>}
                  {p.isNice && <em className="bbs_flag nice">精华</em>}
                  {board === undefined && <span className="level">【{BBS_BOARD_NAMES[p.board]}】</span>}
                </td>
                <td>
                  <Link href={`/bbs/${p.id}`} target="_blank">
                    {p.title}
                  </Link>
                  {p.isLocked && <span className="bbs_flag locked">锁</span>}
                </td>
                <td className="user" style={{ width: 100 }}>
                  {p.author && (
                    <Link href={`/user/${p.author.id}`} target="_blank">
                      {p.author.chineseName}
                    </Link>
                  )}
                </td>
                <td style={{ width: 80 }}>
                  <em>{p.replies}</em>/{p.clicks}
                </td>
                <td className="time" style={{ width: 150 }}>
                  {timeOpposite(p.lastReplyTime, TIME_NEVER)}
                  {p.lastReplyAuthor && ` by ${p.lastReplyAuthor.chineseName}`}
                </td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr>
                <td>还没有主题，来发第一帖吧。</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager base="/bbs" params={params} page={page} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
