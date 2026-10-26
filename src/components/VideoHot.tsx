// 热门录像（2026-09-26 /video 右栏起家；2026-10-20 张老师要求移至首页右栏，
// 替换原「排行前十」板块；/video 列表页改通栏后本组件仅首页使用）：
// 近 30 天录像按点击与他人有效评论综合排序；行内只保留
// 作者（名称+军衔徽章）/ 级别 / 时间成绩（成绩链接进详情，NF 小标保留）。
// 标题链到 /video（同原首页板块标题可点进列表页的语言）。
// 2026-10-26 张老师要求：板块由「热评录像」改回「热门录像」。

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
      <h2>
        <Link href="/video">热门录像</Link>
        {/* 选取规则问号（2026-10-26）：与每日一星同图标、同 data-tip 气泡 */}
        <span
          className="star_help"
          data-tip="选取近30天上传的录像，按“点击量 + 他人有效评论数 × 20”计算热度，取前8部。作者自评、待审及已删除评论不计入。"
        >
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="10" cy="10" r="8.4" />
            <path d="M7.6 8a2.5 2.5 0 1 1 3.4 2.33c-.7.28-1 .77-1 1.47v.3" strokeLinecap="round" />
            <circle cx="10" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
          </svg>
        </span>
      </h2>
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
