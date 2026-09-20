// 录像详情页（移植 views/video/view）

import Link from "next/link";
import { notFound } from "next/navigation";
import { getVideoDetail, videoScores } from "@/lib/queries";
import { LEVEL_NAMES, VIDEO_STATUS_NAMES, type VideoLevel } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { AvatarCell } from "@/components/Cells";
import { Board } from "@/components/Board";

export const dynamic = "force-dynamic";

export default async function VideoViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const videoId = parseInt(id, 10);
  if (!videoId) notFound();

  const video = await getVideoDetail(videoId);
  if (!video) notFound();

  const scores = videoScores(video.board3bv, video.realTime);
  const level = video.level as VideoLevel;

  return (
    <ul id="video_view">
      <li className="main">
        <div className="video_cell box">
          <h1>
            {LEVEL_NAMES[level] ?? video.level}
            <em>{scoreTime(scores.time)}</em>秒{video.noflag && <ins>NF</ins>}
          </h1>
          <h2>
            <span className="board_3bv">
              3BV<em>{video.board3bv}</em>
            </span>
            <span className="score_3bvs">
              3BV/s
              {scores["3bvs"] > 0 ? (
                <em>{score3bvs(scores["3bvs"])}</em>
              ) : (
                <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">
                  {score3bvs(-scores["3bvs"])}
                </del>
              )}
            </span>
            <span className="id">
              ID.<em>{video.id}</em>
            </span>
          </h2>
          <div className="info">
            <Board id={video.id} level={level} board={video.board} size={level === "beg" ? 16 : 8} zoomable={level !== "beg"} />
            <p>
              {video.author && (
                <AvatarCell id={video.author.id} name={video.author.chineseName} sex={video.author.sex} className="author" link />
              )}
              <span className="create_time">
                上传于<em>{timeOpposite(video.createTime)}</em>
              </span>
            </p>
            <p>
              {video.reviewer && video.reviewTime && (
                <>
                  <Link href={`/user/${video.reviewer.id}`} className="avatar_link reviewer" target="_blank">
                    {video.reviewer.chineseName}
                  </Link>
                  <span className="review_time">
                    审核于<em>{timeOpposite(video.reviewTime)}</em>
                  </span>
                </>
              )}
              <span className={`status st${video.status}`}>
                {VIDEO_STATUS_NAMES[video.status] ?? video.status}
              </span>
            </p>
            <p>
              <span className="software">
                软件<em>{video.software} {video.version}</em>
              </span>
              <span className="signature">
                签名<em>{video.signature}</em>
              </span>
            </p>
            <hr />
            <p className="counters">
              <span className="clicks">
                点击<em>{video.clicks}</em>
              </span>
              <span className="comments">
                评论<em>{video.comments}</em>
              </span>
              <span className="downloads">
                下载<em>{video.downloads}</em>
              </span>
            </p>
          </div>
        </div>
      </li>
      <li className="sidebar">
        {video.author && (
          <div className="box user_info_cell">
            <h2>
              <Link href={`/user/${video.author.id}`}>{video.author.chineseName}</Link>
            </h2>
            <p className="title_line">{video.authorTitle}</p>
          </div>
        )}
      </li>
    </ul>
  );
}
