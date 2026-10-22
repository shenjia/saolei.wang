// 录像紧凑行的共享渲染件（2026-09-24 从 VideoTable 抽出）：
// /video 列表（服务端整页）与首页「最新录像」版块（客户端「加载更多」）共用，
// 保证两处列定义/配色/字号完全一致。
// 本组件不含 <table> 骨架与数据获取，只负责表头与行；依赖仅限纯模块
// （lib/format / lib/config），可安全进入客户端 bundle。
// 2026-10-15 张老师需求：表头点击排序（成绩/3BV/3BV/s/评论/点击/上传时间）+ 排序命中
// 高亮——sort 缺省时（首页/用户主页/审核页）保持纯文本表头，行为不变。

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import {
  INVALID_3BVS_TIP,
  INVALID_STNB_TIP,
  LEVEL_NAMES,
  MIN_3BV_FOR_3BVS,
  type VideoLevel,
  type VideoListOrder,
} from "@/lib/config";
import { score3bvs, scoreTime, videoScores, formatDate, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";
import { buildUrl } from "./Pager";

// 2008 版级别配色（.Beg/.Int/.Exp + a.XXX 亮一档链接变体）
const LEVEL_CLS: Record<VideoLevel, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

/** 行高亮列（2026-10-15 扩展：排序命中列；id=上传时间为默认排序，不高亮） */
export type VideoHighlight = Exclude<VideoListOrder, "id">;

/** 表头排序链接参数（base + 固定筛选参数，order/page 由表头自组） */
export interface VideoSortSpec {
  base: string;
  params: Record<string, string | number | undefined>;
  order: VideoListOrder;
}

/** 表头（列定义唯一来源，两处共用）。有 sort 时可排序列渲染为链接（排行表头同语言）。
 *  onSort（2026-10-16）：提供时普通左键点击就地客户端排序（preventDefault 不导航），
 *  修饰键点击/中键仍走真实链接（新标签打开该排序的 URL，URL 即状态兜底）。
 *  noSort3bv（2026-10-20 定向视图）：3BV 列禁排序（整列同值无意义），渲染纯文本 */
export function VideoHead({
  sort,
  onSort,
  noSort3bv,
}: {
  sort?: VideoSortSpec;
  onSort?: (order: VideoListOrder) => void;
  noSort3bv?: boolean;
}) {
  // 各列排序链接（id=默认排序：URL 省略 order 参数）
  function col(order: VideoListOrder, label: string, title: string) {
    if (!sort) return label;
    const href = buildUrl(sort.base, {
      ...sort.params,
      order: order === "id" ? undefined : order,
      page: undefined,
    });
    // id=默认排序（上传时间）不高亮表头（张老师 2026-10-15：保持亮灰即可）
    return (
      <Link
        href={href}
        className={sort.order === order && order !== "id" ? "current" : ""}
        title={title}
        onClick={
          onSort
            ? (e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onSort(order);
              }
            : undefined
        }
      >
        {label}
      </Link>
    );
  }
  return (
    <thead>
      <tr>
        <th>上传者</th>
        <th>级别</th>
        <th>{col("time", "成绩", "按成绩排列（快在前）")}</th>
        {/* 定向视图（3BV 精确筛选）下 3BV 整列同值，禁排序纯文本（2026-10-20） */}
        <th className="c">{noSort3bv ? "3BV" : col("3bv", "3BV", "按 3BV 排列（大在前）")}</th>
        <th className="c">{col("3bvs", "3BV/s", "按 3BV/s 排列（快在前）")}</th>
        {/* 2026-10-20 张老师需求：新增 IOE（效率）/STNB（判雷）指标列，可点击排序 */}
        <th className="c">{col("ioe", "IOE", "按效率 IOE 排列（大在前）")}</th>
        <th className="c">{col("stnb", "STNB", "按判雷 STNB 排列（大在前）")}</th>
        <th>
          {/* 评论/点击同列两个独立排序入口（张老师要求均可触发排序） */}
          {sort ? (
            <>
              {col("comments", "评论", "按评论数排列（多在前）")}
              {" / "}
              {col("clicks", "点击", "按点击数排列（多在前）")}
            </>
          ) : (
            "评论 / 点击"
          )}
        </th>
        {/* 2026-09-26 张老师要求：上传时间移到最右列；2026-10-15 可点击（回到默认排序，无高亮） */}
        <th>{col("id", "上传时间", "按上传时间排列（默认）")}</th>
      </tr>
    </thead>
  );
}

/** 单行（<tr>），列宽/配色见 globals.css 的 .video_table
 *  highlight：排序命中列整列黄（2026-09-27 起按成绩/按3BV/s，2026-10-15 扩展全部排序列；
 *  默认排序（上传时间）不高亮——张老师要求） */
export function VideoRowLine({
  video: v,
  highlight,
}: {
  video: VideoListItem;
  highlight?: VideoHighlight;
}) {
  const scores = videoScores(v.board3bv, v.realTime, v.level as VideoLevel);
  const lvCls = LEVEL_CLS[v.level as VideoLevel] ?? "";
  return (
    <tr>
      <td className="name">
        {v.author ? (
          <>
            {/* 2026-09-24 张老师要求：性别图标与动态行同尺寸（8x8 small），用户名可点击进个人主页 */}
            <AvatarCell id={v.author.id} name={v.author.chineseName} sex={v.author.sex} gender="small" link />
            <TitleBadge title={v.authorTitle} classic={v.authorClassic} link />
          </>
        ) : (
          <span className="avatar_link">?</span>
        )}
      </td>
      <td className={`level ${lvCls}`}>{LEVEL_NAMES[v.level as VideoLevel] ?? v.level}</td>
      <td className={`score ${lvCls}${highlight === "time" ? " current" : ""}`}>
        <Link href={`/video/${v.id}`} target="_blank" title="点击查看录像">
          {scoreTime(scores.time)}
        </Link>
        {v.noflag && (
          <span className="nf" title="仅用左键点击完成游戏，全程不用右键标雷">
            NF
          </span>
        )}
      </td>
      <td className={`c_3bvs bv c${highlight === "3bv" ? " current" : ""}`}>{v.board3bv}</td>
      <td className={`c_3bvs bvs c${highlight === "3bvs" ? " current" : ""}`}>
        {scores["3bvs"] > 0 ? (
          score3bvs(scores["3bvs"])
        ) : (
          // 无效成绩 hover 弹自定义气泡（2026-10-13 张老师要求，同录像详情页）
          <del data-tip={INVALID_3BVS_TIP} aria-label={INVALID_3BVS_TIP}>
            {score3bvs(-scores["3bvs"])}
          </del>
        )}
      </td>
      {/* 指标列（2026-10-20）：IOE 3 位小数 / STNB 1 位小数（与雷达口径一致，
          见 videoscore BASE_METRICS digits）；无指标行（个别老盘解析失败）显 -。
          hover 气泡说明指标含义 */}
      <td className={`c_3bvs ioe c${highlight === "ioe" ? " current" : ""}`}>
        {v.ioe != null ? (
          <span data-tip="IOE 效率：每点击换回的 3BV" aria-label="IOE 效率">
            {v.ioe.toFixed(3)}
          </span>
        ) : (
          <span title="该录像暂无分析数据">-</span>
        )}
      </td>
      <td className={`c_3bvs stnb c${highlight === "stnb" ? " current" : ""}`}>
        {/* 2026-10-22 张老师定：初级 3BV<10（MIN_3BV_FOR_3BVS，中/高级上传下限本就
            高于 4）的 STNB 与 3BV/s 同口径划线不承认——运气盘虚高值（如 3BV=2 的
            4316）不当真成绩展示，也不参与排行（排行侧限界 2026-10-20 已上线） */}
        {v.stnb != null ? (
          v.board3bv >= MIN_3BV_FOR_3BVS[v.level as VideoLevel] ? (
            <span data-tip="STNB 判雷：综合评分（越高越强）" aria-label="STNB 判雷">
              {v.stnb.toFixed(1)}
            </span>
          ) : (
            <del data-tip={INVALID_STNB_TIP} aria-label={INVALID_STNB_TIP}>
              {v.stnb.toFixed(1)}
            </del>
          )
        ) : (
          <span title="该录像暂无分析数据">-</span>
        )}
      </td>
      <td className="counters">
        {/* 评论/点击分别包一层，排序命中时只黄对应数字（2026-10-15） */}
        <em className={highlight === "comments" ? "current" : undefined}>{v.comments}</em>
        {" / "}
        <span className={highlight === "clicks" ? "current" : undefined}>{v.clicks}</span>
      </td>
      <td
        className={`create_time ${isRecent(v.createTime) ? "time--recent" : "time--old"}`}
        title={formatDate(v.createTime, "Y年n月j日 H:i:s")}
      >
        {timeOpposite(v.createTime, TIME_YEAR, "Y-n-j")}
      </td>
    </tr>
  );
}
