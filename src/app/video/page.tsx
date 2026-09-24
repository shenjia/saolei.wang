// 录像列表：级别筛选 + 排序 + 分页
// 2026-09-24 张老师要求：列表参考 2008 版版式（Video_All 紧凑行 → VideoTable），
// 页头参考排行榜版式——h1 与全部筛选器（级别 tabs + 排序 tabs）都放进主体卡片内部。

import { getVideoList } from "@/lib/queries";
import { LEVEL_NAMES, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";
import { Pager, Tabs } from "@/components/Pager";
import { VideoTable } from "@/components/VideoTable";

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
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const { videos, total, pageSize } = await getVideoList({ level, order, author, page });

  return (
    <div id="page" className="main video_old">
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
                    ["id", "按上传时间"],
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
                    ["id", "按上传时间"],
                    ["comments", "按评论数"],
                    ["clicks", "按点击数"],
                  ]}
                />
              )}
            </div>
          </div>
        </div>
        <VideoTable videos={videos} />
        <Pager base="/video" params={{ level, order, author }} page={page} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
