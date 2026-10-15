// 录像列表：级别筛选 + 表头排序 + 加载更多
// 2026-09-24 张老师要求：列表参考 2008 版版式（Video_All 紧凑行 → VideoTable），
// 页头参考排行榜版式——h1 与全部筛选器（级别 tabs + 排序 tabs）都放进主体卡片内部。
// 同日二轮：老式翻页（Pager）改「加载更多」（左右布局：左=总数 右=按钮）。
// 2026-09-26 张老师要求：页面改双栏（复用首页 #home two_columns 版式，主栏宽度与首页一致），
// 右栏新增「热门录像」（至少两条评论，按上传时间倒序）与「统计」两个板块。
// 2026-10-15 张老师要求：右侧排序 tabs 去掉，换搜索框（搜玩家=筛其录像；搜时间成绩=
// 匹配所有显示相同的成绩；输中文出推荐下拉，与排行搜索同体验）；
// 排序改表头点击（成绩/3BV/3BV/s/评论/点击/上传时间），默认上传时间且不高亮，
// 其余排序列高亮表头与对应数据。

import { getHotVideos, getVideoBoxStats, getVideoList } from "@/lib/queries";
import { prisma } from "@/lib/db";
import {
  VIDEO_LEVELS,
  parseVideoListOrder,
  type VideoLevel,
  type VideoListOrder,
} from "@/lib/config";
import { Tabs } from "@/components/Pager";
import { VideoListFeed } from "@/components/VideoListFeed";
import { VideoSearch } from "@/components/VideoSearch";
import { VideoHot } from "@/components/VideoHot";
import { VideoStats } from "@/components/VideoStats";

export const dynamic = "force-dynamic";
export const metadata = { title: "录像" };

function parseLevel(v?: string): VideoLevel | "all" {
  return (VIDEO_LEVELS as readonly string[]).includes(v ?? "") ? (v as VideoLevel) : "all";
}

export default async function VideoListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const level = parseLevel(sp.level);
  const order: VideoListOrder = parseVideoListOrder(sp.order);
  const author = sp.author ? parseInt(sp.author, 10) || undefined : undefined;
  // 时间成绩搜索输入（秒字符串，如 37.29；非法输入忽略）
  const time = sp.time?.trim() || undefined;

  const [{ videos, total, pageSize }, hot, stats, authorName] = await Promise.all([
    getVideoList({ level, order, author, time, page: 1 }),
    getHotVideos(10),
    getVideoBoxStats(),
    // 玩家筛选回显姓名（搜索框显示当前筛选）
    author
      ? prisma.user
          .findUnique({ where: { id: BigInt(author) }, select: { chineseName: true } })
          .then((u) => u?.chineseName)
      : Promise.resolve(undefined),
  ]);

  return (
    <div id="page" className="two_columns video_old">
    <ul id="home">
      <li className="main">
        <div className="box video_box">
          {/* 页头（排行页同款 page_head 编排）：h1 左、级别 tabs 紧随、搜索框贴行尾 */}
          <div className="page_head">
            {/* 标题恒为「录像」（张老师 2026-10-15：搜索后标题不变，级别状态由 tabs 表达） */}
            <h1 className="page_title">录像</h1>
            <div className="video_nav">
              <Tabs
                base="/video"
                params={{ level, order, author, time }}
                name="level"
                current={level}
                options={[
                  ["all", "全部"],
                  ["beg", "初级"],
                  ["int", "中级"],
                  ["exp", "高级"],
                ]}
              />
              <div className="video_search">
                <VideoSearch level={level} order={order} author={author} authorName={authorName} time={time} />
              </div>
            </div>
          </div>
          {/* key=筛选串：Tabs 软导航下服务端数据已变但客户端 useState(initial) 不重置，
              必须强制重挂载（铁律：筛选 tab 驱动的列表必须 key={筛选串}） */}
          <VideoListFeed
            key={`${level}-${order}-${author ?? ""}-${time ?? ""}`}
            initial={videos}
            total={total}
            pageSize={pageSize}
            query={{ level, order, author, time }}
            // 默认排序（上传时间）不高亮表头与时间列；其余排序列高亮（张老师要求）
            highlight={order === "id" ? undefined : order}
            headSort={{ base: "/video", order }}
          />
        </div>
      </li>
      <li className="sidebar">
        <VideoHot videos={hot} />
        <VideoStats stats={stats} />
      </li>
    </ul>
    </div>
  );
}
