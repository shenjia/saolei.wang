// 论坛首页（移植 2008 版 BBS/Index.asp + BBS_All 等列表）
// 板块 tab + 排序 + 精华过滤 + 加载更多；置顶帖优先
// 2026-09-24 改版（张老师）：title 与筛选器移出卡片；筛选器置于 title 右侧；
// 精华并入右侧筛选组；分页改「加载更多」；作者列用首页玩家格式（姓名+性别+军衔）

import Link from "next/link";
import { BBS_BOARDS, BBS_BOARD_NAMES, BBS_ORDERS, getPostPage, type BbsOrder } from "@/lib/bbs";
import { getSession } from "@/lib/auth";
import { Tabs } from "@/components/Pager";
import { BbsFeed } from "@/components/BbsFeed";

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

  const [{ posts, hasMore }, session] = await Promise.all([
    getPostPage({ board, order, nice: nice || undefined, page: 1 }),
    getSession(),
  ]);
  const query: Record<string, string> = {
    ...(board !== undefined ? { board: String(board) } : {}),
    order,
    ...(nice ? { nice: "1" } : {}),
  };

  return (
    <div id="page" className="main">
      {/* 页头（2026-09-24 张老师二轮）：分类 tabs 贴 title 左侧；
          右侧=排序+只看精华两组；管理条例隐藏 */}
      <div className="page_head">
        <h1 className="page_title">论坛</h1>
        <div className="bbs_head_nav">
          <Tabs
            base="/bbs"
            params={query}
            name="board"
            current={board === undefined ? "all" : String(board)}
            options={[
              ["all", "全部"],
              ...BBS_BOARDS.map((b) => [String(b.id), b.name] as [string, string]),
            ]}
          />
          <div className="side_filters">
            <Tabs
              base="/bbs"
              params={query}
              name="order"
              current={order}
              options={Object.entries(BBS_ORDERS) as [string, string][]}
            />
            <Tabs
              base="/bbs"
              params={query}
              name="nice"
              current={nice ? "1" : "0"}
              options={[
                ["0", "全部主题"],
                ["1", "只看精华"],
              ]}
            />
          </div>
          {session && (
            <Link className="button active bbs_post_btn" href="/bbs/post">
              发布主题
            </Link>
          )}
        </div>
      </div>
      <div className="box">
        <table cellPadding={0} cellSpacing={0} className="table full bbs_list">
          <thead>
            <tr>
              <th className="cat">分类</th>
              <th className="topic">主题</th>
              <th>作者</th>
              <th className="num">回复/点击</th>
              <th className="time">最后更新</th>
            </tr>
          </thead>
          <tbody>
            <BbsFeed initial={posts} initialHasMore={hasMore} query={query} showBoard={board === undefined} />
          </tbody>
        </table>
      </div>
    </div>
  );
}
