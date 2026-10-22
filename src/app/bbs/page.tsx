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
// 2026-10-22（张老师需求）：「精华」从分类筛选项改为正交开关（对齐录像页 NF）——
//   页头（tabs/搜索/发布按钮）收拢进 BbsSection 客户端壳（开关与列表就地联动），
//   本页只做筛选解析 + 首屏取数；精华与板块叠加（board=1&nice=1=技术区精华），
//   旧深链 board=nice / nice=1 / order=nice 一律 301 归一到 canonical URL

import { redirect } from "next/navigation";
import { BBS_BOARD_NAMES, getPostPage } from "@/lib/bbs";
import { getSession } from "@/lib/auth";
import { BbsSection } from "@/components/BbsFeed";

export const dynamic = "force-dynamic";
export const metadata = { title: "论坛" };

export default async function BbsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // 精华开关态：nice=1（正交，可与板块叠加）；board=nice / order=nice 旧深链兼容视为开启
  const nice = sp.nice === "1" || sp.order === "nice" || sp.board === "nice";
  const boardRaw = parseInt(sp.board ?? "", 10);
  const board = BBS_BOARD_NAMES[boardRaw] !== undefined ? boardRaw : undefined;
  // 搜索关键字（2026-09-26）：搜索态优先于板块/精华筛选（列表只按 q 过滤，board/nice 忽略）
  const q = (sp.q ?? "").trim().slice(0, 30);

  // 旧深链归一（2026-10-22）：精华已不是 board 的一种，canonical 形态=board + nice=1；
  //   board=nice / order=nice 是历史形态需 301 归一（否则 syncNiceUrl 只增删 nice 参数，
  //   旧参数残留形成脏 URL）；nice=1 本身就是 canonical，不能进本条件（否则死循环）。
  //   搜索态 q 优先，board/nice 一并剥掉
  if (sp.order === "nice" || sp.board === "nice") {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    else {
      if (board !== undefined) params.set("board", String(board));
      params.set("nice", "1");
    }
    const qs = params.toString();
    redirect(qs ? `/bbs?${qs}` : "/bbs");
  }

  const [{ posts, hasMore, total }, session] = await Promise.all([
    getPostPage({
      board: q ? undefined : board,
      order: "reply",
      nice: q ? undefined : nice || undefined,
      q: q || undefined,
      page: 1,
    }),
    getSession(),
  ]);
  const query: Record<string, string> = q
    ? { q }
    : {
        ...(board !== undefined ? { board: String(board) } : {}),
        ...(nice ? { nice: "1" } : {}),
      };
  const feedKey = q ? `q-${q}` : `${board ?? "all"}${nice ? "-nice" : ""}`;

  return (
    <div id="page" className="main bbs_old">
      {/* 2026-10-22：页头（title+分类 tabs+精华开关+发布按钮+搜索框）整体收进
          BbsSection 客户端壳（与录像页 VideoListSection 同模式）——精华开关就地
          重拉需与列表联动，RSC 不能传函数 prop；本页只解析筛选+首屏取数 */}
      <div className="box">
        <BbsSection
          key={feedKey}
          initial={posts}
          initialHasMore={hasMore}
          total={total}
          query={query}
          canPost={!!session}
          emptyMsg={q ? `没有找到与“${q}”相关的主题` : undefined}
        />
      </div>
    </div>
  );
}
