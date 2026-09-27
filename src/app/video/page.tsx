// 录像列表：级别筛选 + 排序 + 加载更多
// 2026-09-24 张老师要求：列表参考 2008 版版式（Video_All 紧凑行 → VideoTable），
// 页头参考排行榜版式——h1 与全部筛选器（级别 tabs + 排序 tabs）都放进主体卡片内部。
// 同日二轮：老式翻页（Pager）改「加载更多」（左右布局：左=总数 右=按钮）。
// 2026-09-26 张老师要求：页面改双栏（复用首页 #home two_columns 版式，主栏宽度与首页一致），
// 右栏新增「热门录像」（至少两条评论，按上传时间倒序）与「统计」两个板块。

import { getHotVideos, getVideoBoxStats, getVideoList } from "@/lib/queries";
import { LEVEL_NAMES, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";
import { Tabs } from "@/components/Pager";
import { VideoListFeed } from "@/components/VideoListFeed";
import { VideoHot } from "@/components/VideoHot";
import { VideoStats } from "@/components/VideoStats";

export const dynamic = "force-dynamic";
export const metadata = { title: "录像 | 扫雷网" };

function parseLevel(v?: string): VideoLevel | "all" {
  return (VIDEO_LEVELS as readonly string[]).includes(v ?? "") ? (v as VideoLevel) : "all";
}
function parseOrder(v?: string): "id" | "time" | "3bvs" | "comments" | "clicks" {
  return v === "time" || v === "3bvs" || v === "comments" || v === "clicks" ? v : "id";
}

export default async function VideoListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const level = parseLevel(sp.level);
  const order = parseOrder(sp.order);
  const author = sp.author ? parseInt(sp.author, 10) || undefined : undefined;

  const [{ videos, total, pageSize }, hot, stats] = await Promise.all([
    getVideoList({ level, order, author, page: 1 }),
    getHotVideos(10),
    getVideoBoxStats(),
  ]);

  return (
    <div id="page" className="two_columns video_old">
    <ul id="home">
      <li className="main">
        <div className="box video_box">
          {/* 页头（排行页同款 page_head 编排）：h1 左、级别 tabs 紧随、排序 tabs 贴行尾 */}
          <div className="page_head">
            <h1 className="page_title">{author ? `${LEVEL_NAMES[level]}录像` : "录像"}</h1>
            <div className="video_nav">
              <Tabs
                base="/video"
                params={{ level, order, author }}
                name="level"
                current={level}
                options={[
                  ["all", "全部"],
                  ["beg", "初级"],
                  ["int", "中级"],
                  ["exp", "高级"],
                ]}
              />
              <div className="order_filters">
                {level !== "all" ? (
                  <Tabs
                    base="/video"
                    params={{ level, order, author }}
                    name="order"
                    current={order}
                    options={[
                      ["id", "按时间"],
                      ["time", "按成绩"],
                      ["3bvs", "按3BV/s"],
                    ]}
                  />
                ) : (
                  <Tabs
                    base="/video"
                    params={{ level, order, author }}
                    name="order"
                    current={order}
                    options={[
                      ["id", "按时间"],
                      ["comments", "按评论"],
                      ["clicks", "按点击"],
                    ]}
                  />
                )}
              </div>
            </div>
          </div>
          {/* key=筛选串：Tabs 软导航下服务端数据已变但客户端 useState(initial) 不重置，
              必须强制重挂载（铁律：筛选 tab 驱动的列表必须 key={筛选串}） */}
          <VideoListFeed
            key={`${level}-${order}-${author ?? ""}`}
            initial={videos}
            total={total}
            pageSize={pageSize}
            query={{ level, order, author }}
            highlight={order === "time" ? "time" : order === "3bvs" ? "3bvs" : undefined}
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
