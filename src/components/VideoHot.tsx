// 热评录像（2026-09-26 /video 右栏起家；2026-10-20 张老师要求移至首页右栏，
// 替换原「排行前十」板块；/video 列表页改通栏后本组件仅首页使用）：
// 按上传时间倒序显示有评论的录像；行内只保留
// 作者（名称+军衔徽章）/ 级别 / 时间成绩（成绩链接进详情，NF 小标保留）。
// 标题链到 /video（同原首页板块标题可点进列表页的语言）。
// 2026-10-23 张老师要求：板块更名「热门录像」→「热评录像」，口径 ≥2 → >0。

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
      <Link href="/video">
        <h2>热评录像</h2>
      </Link>
      <table cellPadding={0} cellSpacing={0} className="table full video_hot_table">
        <tbody>
          {videos.map((v) => {
            const lv = v.level as VideoLevel;
            const lvCls = LEVEL_CLS[lv] ?? "";
            const scores = videoScores(v.board3bv, v.realTime, lv);
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
                      <TitleBadge title={v.authorTitle} classic={v.authorClassic} link />
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
