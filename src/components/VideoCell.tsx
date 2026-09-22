// 录像列表单元格（移植 views/video/_detailCell），/video 列表与 /video/review 审核列表共用

import Link from "next/link";
import { videoScores, type VideoListItem } from "@/lib/queries";
import { LEVEL_NAMES, VIDEO_STATUS_NAMES, type VideoLevel } from "@/lib/config";
import { timeOpposite } from "@/lib/format";
import { AvatarCell, Score3bvs, ScoreTime, TitleBadge } from "./Cells";
import { Board } from "./Board";

export function VideoDetailCell({ video }: { video: VideoListItem }) {
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
