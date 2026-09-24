// 录像列表·紧凑行版式（2026-09-24 张老师要求：参考 2008 版 Video_All.asp 的版式）
// 每行：时间 | 【神界/人界】[军衔] 作者 | 3BV=xx | 3BV/s=xx | 级别+成绩(+NF) | 点击 | 评论
// 2008 版无单独表头（靠行内 label 自释义），保留该风格；行 hover 高亮、整行点详情新开。
// 与排行表共用 .ranking_table 的骨架样式（td 16px/24px、th 14px 定稿口径）。

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import { videoScores } from "@/lib/queries";
import { LEVEL_NAMES, type VideoLevel } from "@/lib/config";
import { score3bvs, scoreTime, formatDate } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";

// 2008 版级别配色（.Beg/.Int/.Exp + a.XXX 亮一档链接变体）
const LEVEL_CLS: Record<VideoLevel, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

export function VideoTable({ videos, heroIds }: { videos: VideoListItem[]; heroIds?: Set<number> }) {
  return (
    <table cellPadding={0} cellSpacing={0} className="ranking_table video_table">
      <thead>
        <tr>
          <th>时间</th>
          <th>作者</th>
          <th>3BV</th>
          <th>3BV/s</th>
          <th>成绩</th>
          <th>点击</th>
          <th>评论</th>
        </tr>
      </thead>
      <tbody>
        {videos.map((v) => {
          const scores = videoScores(v.board3bv, v.realTime);
          const isHero = heroIds?.has(v.author?.id ?? -1);
          return (
            <tr key={v.id}>
              <td className="create_time" title={formatDate(v.createTime, "Y-n-j H:i:s")}>
                {formatDate(v.createTime, "Y-n-j H:i")}
              </td>
              <td className="name">
                {isHero !== undefined && (
                  <span className={`world_tag ${isHero ? "world1" : "world2"}`}>
                    【{isHero ? "神界" : "人界"}】
                  </span>
                )}
                {v.author ? (
                  <>
                    <AvatarCell id={v.author.id} name={v.author.chineseName} sex={v.author.sex} />
                  </>
                ) : (
                  <span className="avatar_link">?</span>
                )}
              </td>
              <td className="c_3bvs bv">{v.board3bv}</td>
              <td className="c_3bvs bvs">
                {scores["3bvs"] > 0 ? (
                  score3bvs(scores["3bvs"])
                ) : (
                  <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">
                    {score3bvs(-scores["3bvs"])}
                  </del>
                )}
              </td>
              <td className="score">
                <span className={LEVEL_CLS[v.level as VideoLevel] ?? ""}>
                  {LEVEL_NAMES[v.level as VideoLevel] ?? v.level}
                </span>{" "}
                <Link href={`/video/${v.id}`} target="_blank" title="点击查看录像">
                  {scoreTime(scores.time)}
                </Link>
                {v.noflag && <span className="nf" title="仅用左键点击完成游戏，全程不用右键标雷">NF</span>}
                <TitleBadge title={v.authorTitle} link />
              </td>
              <td className="counters">{v.clicks}</td>
              <td className="counters">{v.comments}</td>
            </tr>
          );
        })}
        {videos.length === 0 && (
          <tr>
            <td colSpan={7} style={{ textAlign: "center" }}>
              暂无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
