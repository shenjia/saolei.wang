// 录像详情页（移植 views/video/view）

import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getComments, getCommentsCount, getVideoDetail, videoScores } from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { clientIp, uniqueVideoAction } from "@/lib/stat";
import {
  COMMENT_TOP_NUMBER,
  isManager,
  LEVEL_NAMES,
  USER_ROLE,
  VIDEO_STATUS,
  VIDEO_STATUS_NAMES,
  type VideoLevel,
} from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { Board } from "@/components/Board";
import { BoardPlay } from "@/components/BoardPlay";
import { CommentForm, CommentList } from "@/components/Comments";
import { FlopPlayer, PlayButton } from "@/components/FlopPlayer";
import { ReviewButtons } from "@/components/ReviewButtons";

export const dynamic = "force-dynamic";

export default async function VideoViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const videoId = parseInt(id, 10);
  if (!videoId) notFound();

  const video = await getVideoDetail(videoId);
  if (!video) notFound();
  const [session, comments, commentTotal] = await Promise.all([
    getSession(),
    getComments(videoId, 0, COMMENT_TOP_NUMBER),
    // 评论总数（「加载更多」括号内剩余条数口径，按实际行数而非 video_stat 冗余计数）
    getCommentsCount(videoId),
    // 点击计数（移植 actionView 的 uniqueAction('click')）
    (async () => uniqueVideoAction(videoId, "click", clientIp(await headers())))(),
  ]);

  const scores = videoScores(video.board3bv, video.realTime);
  const level = video.level as VideoLevel;

  return (
    <div id="page" className="two_columns">
    <ul id="video_view">
      <li className="main">
        <div className="video_cell box">
          <h1>
            {LEVEL_NAMES[level] ?? video.level}
            <em>{scoreTime(scores.time)}</em>秒{video.noflag && <ins>NF</ins>}
            <span className="id">
              ID:<em>{video.id}</em>
            </span>
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
          </h2>
          <div className="info">
            <BoardPlay uri={`/videos${video.filepath}`}>
              <Board id={video.id} level={level} board={video.board} size={16} />
            </BoardPlay>
            <p>
              {video.author && (
                <>
                  <AvatarCell id={video.author.id} name={video.author.chineseName} sex={video.author.sex} className="author" link />
                  <TitleBadge title={video.authorTitle} link />
                </>
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
            <PlayButton uri={`/videos${video.filepath}`} />
            <a className="button" href={`/video/download/${video.id}`}>
              下载录像
            </a>
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
            {session &&
              ((isManager(session.role) && video.status === VIDEO_STATUS.NORMAL) ||
                session.role === USER_ROLE.ADMINISTRATOR) && (
                <p>
                  <ReviewButtons videoId={video.id} status={video.status} />
                </p>
              )}
          </div>
        </div>
        {session && (
          <div className="post box">
            <CommentForm videoId={video.id} />
          </div>
        )}
        <CommentList
          videoId={video.id}
          initial={comments}
          initialHasMore={comments.length < commentTotal}
          initialTotal={commentTotal}
        />
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
    <FlopPlayer />
    </div>
  );
}
