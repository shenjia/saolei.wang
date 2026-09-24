// 录像列表·紧凑行版式（2026-09-24 张老师要求：参考 2008 版 Video_All.asp 的版式）
// 每行：上传者（名字+军衔） | 上传时间 | 级别 | 成绩(+NF) | 3BV | 3BV/s | 评论 / 点击
// 2026-09-24 二轮：取消神界/人界标识；「作者」改「上传者」且军衔徽章并入该列；
// 3BV/3BVS 移到成绩之后；点击与评论合并一列（评论在前、点击在后，论坛「回复 / 点击」同款）。
// 2026-09-24 三轮：时间列改相对时间（站内动态同口径 TIME_YEAR：一年内相对、超过显示日期，
// 配 isRecent 明暗）；级别与成绩拆成两列；表头居左与内容对齐。
// 2026-09-24 四轮：时间列改「上传时间」并贴到上传者之后；级别字号降一档且成绩与级别同色；
// 3BV/3BV/s 数字列居中。
// 与排行表共用 .ranking_table 的骨架样式（td 16px/24px、th 14px 定稿口径）。

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import { videoScores } from "@/lib/queries";
import { LEVEL_NAMES, type VideoLevel } from "@/lib/config";
import { score3bvs, scoreTime, formatDate, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";

// 2008 版级别配色（.Beg/.Int/.Exp + a.XXX 亮一档链接变体）
const LEVEL_CLS: Record<VideoLevel, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

export function VideoTable({ videos }: { videos: VideoListItem[] }) {
  return (
    <table cellPadding={0} cellSpacing={0} className="ranking_table video_table">
      <thead>
        <tr>
          <th>上传者</th>
          <th>上传时间</th>
          <th>级别</th>
          <th>成绩</th>
          <th className="c">3BV</th>
          <th className="c">3BV/s</th>
          <th>评论 / 点击</th>
        </tr>
      </thead>
      <tbody>
        {videos.map((v) => {
          const scores = videoScores(v.board3bv, v.realTime);
          const lvCls = LEVEL_CLS[v.level as VideoLevel] ?? "";
          return (
            <tr key={v.id}>
              <td className="name">
                {v.author ? (
                  <>
                    <AvatarCell id={v.author.id} name={v.author.chineseName} sex={v.author.sex} />
                    <TitleBadge title={v.authorTitle} link />
                  </>
                ) : (
                  <span className="avatar_link">?</span>
                )}
              </td>
              <td
                className={`create_time ${isRecent(v.createTime) ? "time--recent" : "time--old"}`}
                title={formatDate(v.createTime, "Y年n月j日 H:i:s")}
              >
                {timeOpposite(v.createTime, TIME_YEAR, "Y-n-j")}
              </td>
              <td className={`level ${lvCls}`}>{LEVEL_NAMES[v.level as VideoLevel] ?? v.level}</td>
              <td className={`score ${lvCls}`}>
                <Link href={`/video/${v.id}`} target="_blank" title="点击查看录像">
                  {scoreTime(scores.time)}
                </Link>
                {v.noflag && <span className="nf" title="仅用左键点击完成游戏，全程不用右键标雷">NF</span>}
              </td>
              <td className="c_3bvs bv c">{v.board3bv}</td>
              <td className="c_3bvs bvs c">
                {scores["3bvs"] > 0 ? (
                  score3bvs(scores["3bvs"])
                ) : (
                  <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">
                    {score3bvs(-scores["3bvs"])}
                  </del>
                )}
              </td>
              <td className="counters">
                <em>{v.comments}</em> / {v.clicks}
              </td>
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
