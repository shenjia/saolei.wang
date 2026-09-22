// 录像列表：级别筛选 + 排序 + 分页（移植 views/video/list + _detailCell）

import Link from "next/link";
import { getVideoList } from "@/lib/queries";
import { LEVEL_NAMES, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";
import { Pager, Tabs } from "@/components/Pager";
import { VideoDetailCell } from "@/components/VideoCell";

export const dynamic = "force-dynamic";

function parseLevel(v?: string): VideoLevel | "all" {
  return (VIDEO_LEVELS as readonly string[]).includes(v ?? "") ? (v as VideoLevel) : "all";
}
function parseOrder(v?: string): "id" | "time" | "3bvs" {
  return v === "time" || v === "3bvs" ? v : "id";
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
    <div id="page" className="two_columns">
      <div id="video_list_header" className="box">
        <h1>{author ? `${LEVEL_NAMES[level]}录像` : "录像"}</h1>
        <div className="filters">
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
          {level !== "all" && (
            <Tabs
              base="/video"
              params={{ level, order, author }}
              name="order"
              current={order}
              options={[
                ["id", "按上传时间排列"],
                ["time", "按成绩排列"],
                ["3bvs", "按3BV/s排列"],
              ]}
            />
          )}
        </div>
      </div>
      <div id="video_list" className={`ranking_list order_by_${order} mode_detail`}>
        {videos.map((v) => (
          <Link key={v.id} href={`/video/${v.id}`} target="_blank">
            <VideoDetailCell video={v} />
          </Link>
        ))}
      </div>
      <Pager base="/video" params={{ level, order, author }} page={page} total={total} pageSize={pageSize} />
    </div>
  );
}
