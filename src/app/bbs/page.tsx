// 论坛首页（移植 2008 版 BBS/Index.asp + BBS_All 等列表）
// 板块 tab + 加载更多
// 2026-09-24 改版（张老师）：title 与筛选器移出卡片；分页改「加载更多」；作者列用首页玩家格式
// 2026-09-24 三轮：去掉「全部主题/只看精华」筛选与「点击数/回复数」排序；
//   BbsFeed 加 key=筛选串——App Router 软导航复用组件实例时 useState(initial) 不重置，
//   导致筛选 URL 变了但列表不刷新（实测复现），key 变化强制重挂载
// 2026-09-24 四轮：「只看精华」回归，作为排序组第三项（选中=nice=1+固定更新时间排序，与 order 互斥）
// 2026-09-25 六轮（张老师）：「精华」并入左侧分类筛选组末位（board=nice，跨板块）；
//   取消排序筛选器——列表固定按更新时间排序；发布按钮改 small 与「加载更多」同尺寸
// 2026-09-25 七轮（张老师）：分类与主题合并成一列——表头「分类 / 主题」，
//   行内分类改为标题前的灰色标签（board_tag），不再单独占一列
// 2026-09-26（张老师）：右上角加搜索框（样式参考排行页 goto_form）——
//   ?q=关键字 按标题或作者人名过滤主题；搜索态下分类 tabs 收起，
//   换成「搜索 "xx" 的结果 N 帖 + 清除搜索」返回常规列表

import Link from "next/link";
import { BBS_BOARDS, BBS_BOARD_NAMES, getPostPage } from "@/lib/bbs";
import { getSession } from "@/lib/auth";
import { Tabs } from "@/components/Pager";
import { BbsFeed } from "@/components/BbsFeed";
import { BbsSearch } from "@/components/BbsSearch";
import { TotalCount } from "@/components/TotalCount";

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
  // 搜索关键字（2026-09-26）：搜索态优先于板块/精华筛选（列表只按 q 过滤，board/nice 忽略）
  const q = (sp.q ?? "").trim().slice(0, 30);

  const [{ posts, hasMore, total }, session] = await Promise.all([
    getPostPage({ board: q ? undefined : board, order: "reply", nice: q ? undefined : nice || undefined, q: q || undefined, page: 1 }),
    getSession(),
  ]);
  const query: Record<string, string> = q
    ? { q }
    : nice
      ? { board: "nice" }
      : board !== undefined
        ? { board: String(board) }
        : {};
  const feedKey = q ? `q-${q}` : nice ? "nice" : (board ?? "all");

  return (
    <div id="page" className="main bbs_old">
      {/* 2026-09-24 五轮（张老师要求）：页头（title+分类 tabs+发布按钮）
          整体移入主体卡片内，与排行/录像页同编排——h1 左、分类 tabs 紧随（六轮：
          「精华」为分类组末位项）、发布主题贴行尾 */}
      <div className="box">
        <div className="page_head">
          <h1 className="page_title">论坛</h1>
          <div className="bbs_head_nav">
            {q ? (
              /* 搜索态：tabs 收起，显示结果条 + 清除返回（筛选与搜索互斥，q 优先） */
              <div className="bbs_search_bar">
                <span className="bbs_search_kw">
                  搜索 <em>“{q}”</em> 的结果
                </span>
                <TotalCount total={total} unit="帖" />
                <Link className="button small" href="/bbs">
                  清除搜索
                </Link>
              </div>
            ) : (
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
            )}
            {/* 动作组（2026-09-26 二轮张老师：发布按钮移到搜索框左边、垂直居中对齐）：
                组内 align-items:center——按钮随搜索胶囊居中，整体贴行尾 */}
            <div className="bbs_actions">
              {session && (
                <Link className="button active small bbs_post_btn" href="/bbs/post">
                  发布主题
                </Link>
              )}
              <BbsSearch initialQ={q} />
            </div>
          </div>
        </div>
        <table cellPadding={0} cellSpacing={0} className="table full bbs_list">
          <thead>
            <tr>
              <th className="topic">分类 / 主题</th>
              <th className="author">作者</th>
              <th className="num">评论 / 阅读</th>
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
              showBoard={true}
              emptyMsg={q ? `没有找到与“${q}”相关的主题` : undefined}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}
