// 录像列表：级别筛选 + 排序 + 分页（移植 views/video/list + _detailCell）

import Link from "next/link";
import { getVideoList, videoScores, type VideoListItem } from "@/lib/queries";
import {
  LEVEL_NAMES,
  VIDEO_LEVELS,
  VIDEO_STATUS_NAMES,
  type VideoLevel,
} from "@/lib/config";
import { timeOpposite } from "@/lib/format";
import { AvatarCell, Score3bvs, ScoreTime, TitleBadge } from "@/components/Cells";
import { Board } from "@/components/Board";
import { Pager, Tabs } from "@/components/Pager";

export const dynamic = "force-dynamic";

function parseLevel(v?: string): VideoLevel | "all" {
  return (VIDEO_LEVELS as readonly string[]).includes(v ?? "") ? (v as VideoLevel) : "all";
}
function parseOrder(v?: string): "id" | "time" | "3bvs" {
  return v === "time" || v === "3bvs" ? v : "id";
}

function VideoDetailCell({ video }: { video: VideoListItem }) {
  const scores = videoScores(video.board3bv, video.realTime);
  return (
    <div className="video_cell box">
      <table cellPadding={0} cellSpacing={0}>
        <tbody>
          <tr>
            <td>
              <p>
                <span className="level">{LEVEL_NAMES[video.level as VideoLevel] ?? video.level}</span>
                <ScoreTime score={scores.time} noflag={video.noflag} />
              </p>
              <p>
                <span className="board_3bv">
                  3BV<em>{video.board3bv}</em>
                </span>
                <Score3bvs score={scores["3bvs"]} />
                <span className="id">
                  ID.
                  <Link href={`/video/${video.id}`} target="_blank">
                    <em>{video.id}</em>
                  </Link>
                </span>
              </p>
              <br />
              <p>
                {video.author && (
                  <AvatarCell id={video.author.id} name={video.author.chineseName} sex={video.author.sex} className="author" />
                )}
                <TitleBadge title={video.authorTitle} />
                <span className="create_time">
                  上传于<em>{timeOpposite(video.createTime)}</em>
                </span>
              </p>
              <br />
              <p>
                <span className="software">
                  软件<em>{video.software} {video.version}</em>
                </span>
                <span className="clicks">
                  点击<em>{video.clicks}</em>
                </span>
                <span className="comments">
                  评论<em>{video.comments}</em>
                </span>
                <span className={`status st${video.status}`}>
                  {VIDEO_STATUS_NAMES[video.status] ?? video.status}
                </span>
              </p>
            </td>
            <td className="right">
              <Board
                id={video.id}
                level={video.level as VideoLevel}
                board={video.board}
                size={video.level === "beg" ? 16 : 8}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
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
