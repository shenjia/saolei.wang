// 论坛首页（移植 2008 版 BBS/Index.asp + BBS_All 等列表）
// 板块 tab + 加载更多
// 2026-09-24 改版（张老师）：title 与筛选器移出卡片；分页改「加载更多」；作者列用首页玩家格式
// 2026-09-24 三轮：去掉「全部主题/只看精华」筛选与「点击数/回复数」排序；
//   BbsFeed 加 key=筛选串——App Router 软导航复用组件实例时 useState(initial) 不重置，
//   导致筛选 URL 变了但列表不刷新（实测复现），key 变化强制重挂载
// 2026-09-24 四轮：「只看精华」回归，作为排序组第三项（选中=nice=1+固定更新时间排序，与 order 互斥）
// 2026-09-25 六轮（张老师）：「精华」并入左侧分类筛选组末位（board=nice，跨板块）；
//   取消排序筛选器——列表固定按更新时间排序；发布按钮改 small 与「加载更多」同尺寸

import Link from "next/link";
import { BBS_BOARDS, BBS_BOARD_NAMES, getPostPage } from "@/lib/bbs";
import { getSession } from "@/lib/auth";
import { Tabs } from "@/components/Pager";
import { BbsFeed } from "@/components/BbsFeed";

export const dynamic = "force-dynamic";
export const metadata = { title: "论坛 | 扫雷网" };

export default async function BbsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // 六轮：「精华」并入分类筛选组（board=nice = 只看精华，跨板块、与具体板块互斥）；
  //   旧深链 ?nice=1 / ?order=nice 兼容视作 board=nice；排序固定更新时间（order 参数作废）
  const nice = sp.nice === "1" || sp.order === "nice" || sp.board === "nice";
  const boardRaw = parseInt(sp.board ?? "", 10);
  const board = !nice && BBS_BOARD_NAMES[boardRaw] !== undefined ? boardRaw : undefined;

  const [{ posts, hasMore, total }, session] = await Promise.all([
    getPostPage({ board, order: "reply", nice: nice || undefined, page: 1 }),
    getSession(),
  ]);
  const query: Record<string, string> = nice
    ? { board: "nice" }
    : board !== undefined
      ? { board: String(board) }
      : {};
  const feedKey = nice ? "nice" : (board ?? "all");

  return (
    <div id="page" className="main bbs_old">
      {/* 2026-09-24 五轮（张老师要求）：页头（title+分类 tabs+发布按钮）
          整体移入主体卡片内，与排行/录像页同编排——h1 左、分类 tabs 紧随（六轮：
          「精华」为分类组末位项）、发布主题贴行尾 */}
      <div className="box">
        <div className="page_head">
          <h1 className="page_title">论坛</h1>
          <div className="bbs_head_nav">
            <Tabs
              base="/bbs"
              params={query}
              name="board"
              current={nice ? "nice" : board === undefined ? "all" : String(board)}
              options={[
                ["all", "全部"],
                ...BBS_BOARDS.map((b) => [String(b.id), b.name] as [string, string]),
                ["nice", "精华"],
              ]}
            />
            {session && (
              <Link className="button active small bbs_post_btn" href="/bbs/post">
                发布主题
              </Link>
            )}
          </div>
        </div>
        <table cellPadding={0} cellSpacing={0} className="table full bbs_list">
          <thead>
            <tr>
              <th className="cat">分类</th>
              <th className="topic">主题</th>
              <th className="author">作者</th>
              <th className="num">回复 / 点击</th>
              <th className="time">最后更新</th>
            </tr>
          </thead>
          <tbody>
            <BbsFeed
              key={feedKey}
              initial={posts}
              initialHasMore={hasMore}
              total={total}
              query={query}
              showBoard={board === undefined}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}
