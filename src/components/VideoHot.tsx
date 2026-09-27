// 热门录像（/video 右栏，2026-09-26 张老师要求）：
// 按上传时间倒序显示至少两条评论的录像；行内只保留
// 作者（名称+军衔徽章）/ 级别 / 时间成绩（成绩链接进详情，NF 小标保留）。

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import { LEVEL_NAMES, type VideoLevel } from "@/lib/config";
import { scoreTime, videoScores } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";

const LEVEL_CLS: Record<VideoLevel, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

export function VideoHot({ videos }: { videos: VideoListItem[] }) {
  if (!videos.length) return null;
  return (
    <div id="video_hot" className="box">
      <h2>热门录像</h2>
      <table cellPadding={0} cellSpacing={0} className="table full video_hot_table">
        <tbody>
          {videos.map((v) => {
            const lv = v.level as VideoLevel;
            const lvCls = LEVEL_CLS[lv] ?? "";
            const scores = videoScores(v.board3bv, v.realTime);
            return (
              <tr key={v.id}>
                <td className="user">
                  {v.author ? (
                    <>
                      <AvatarCell
                        id={v.author.id}
                        name={v.author.chineseName}
                        sex={v.author.sex}
                        gender="small"
                        link
                      />
                      <TitleBadge title={v.authorTitle} link />
                    </>
                  ) : (
                    <span className="avatar_link">?</span>
                  )}
                </td>
                <td className={`level ${lvCls}`}>{LEVEL_NAMES[lv] ?? v.level}</td>
                <td className={`score ${lvCls}`}>
                  <LinkOrScore video={v} time={scoreTime(scores.time)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 成绩（可点击进详情，与录像列表行语义一致；NF 小标沿用列表样式） */
function LinkOrScore({ video, time }: { video: VideoListItem; time: string }) {
  const inner = (
    <>
      {time}
      {video.noflag && (
        <span className="nf" title="仅用左键点击完成游戏，全程不用右键标雷">
          NF
        </span>
      )}
    </>
  );
  return (
    <Link href={`/video/${video.id}`} target="_blank" title="点击查看录像">
      {inner}
    </Link>
  );
}
