// 录像列表·紧凑行版式（2026-09-24 张老师要求：参考 2008 版 Video_All.asp 的版式）
// 每行：上传者（名字+军衔） | 上传时间 | 级别 | 成绩(+NF) | 3BV | 3BV/s | 评论 / 点击
// 2026-09-24 二轮：取消神界/人界标识；「作者」改「上传者」且军衔徽章并入该列；
// 3BV/3BVS 移到成绩之后；点击与评论合并一列（评论在前、点击在后，论坛「回复 / 点击」同款）。
// 2026-09-24 三轮：时间列改相对时间（站内动态同口径 TIME_YEAR：一年内相对、超过显示日期，
// 配 isRecent 明暗）；级别与成绩拆成两列；表头居左与内容对齐。
// 2026-09-24 四轮：时间列改「上传时间」并贴到上传者之后；级别字号降一档且成绩与级别同色；
// 3BV/3BV/s 数字列居中。
// 2026-09-24 五轮：表头与行抽出到 VideoRows，与首页「最新录像」版块（客户端加载更多）共用渲染。
// 与排行表共用 .ranking_table 的骨架样式（td 16px/24px、th 14px 定稿口径）。

import type { VideoListItem } from "@/lib/queries";
import { VideoHead, VideoRowLine } from "./VideoRows";

export function VideoTable({ videos }: { videos: VideoListItem[] }) {
  return (
    <table cellPadding={0} cellSpacing={0} className="ranking_table video_table">
      <VideoHead />
      <tbody>
        {videos.map((v) => (
          <VideoRowLine key={v.id} video={v} />
        ))}
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
