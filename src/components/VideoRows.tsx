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
  VIDEO_LIST_DEFAULT_DIR,
  type VideoLevel,
  type VideoListOrder,
  type VideoListDir,
} from "@/lib/config";
import { score3bvs, scoreTime, videoScores, formatDate, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";
import { buildUrl } from "./Pager";

// 2008 版级别配色（.Beg/.Int/.Exp + a.XXX 亮一档链接变体）
const LEVEL_CLS: Record<VideoLevel, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

// 软件图标映射（2026-10-29 张老师需求：列表新增「软件」列，级别列之前，图标+hover 全名气泡）。
// 图标 /images/software/*.png 统一 32×32 原图、16px 展示（retina 2x）；全名口径同下载页。
// Vienna 原图 16×16 像素风放大展示（sw--pixel 保硬边）；元扫雷按前缀匹配（库值「元扫雷3.3.4」
// 带版本号）；空值/未知软件（历史数据 25 条）灰色 ? 占位。
// 2026-10-29 二轮（张老师）：气泡显「全名+版本号」（逐盘版本：Arbiter 0.49/0.50/0.52 各代）；
// 图标一律灰度（grayscale，配色不抢级别色语言），列表与详情页同口径（三轮定稿）。
// Arbiter 白底图标灰度后仍过亮 → dim 追加 brightness 压暗
const SOFTWARE_ICONS: Record<
  string,
  { icon: string; name: string; pixel?: boolean; dim?: boolean }
> = {
  Arbiter: { icon: "/images/software/arbiter.png", name: "Minesweeper Arbiter", dim: true },
  Clone: { icon: "/images/software/clone.png", name: "Minesweeper Clone" },
  Vienna: { icon: "/images/software/vienna.png", name: "Viennasweeper", pixel: true },
  "Saolei.wang": { icon: "/images/software/saolei.png", name: "Saolei.wang" },
};

function softwareIcon(software: string): {
  icon: string;
  name: string;
  pixel?: boolean;
  dim?: boolean;
} | null {
  const hit = SOFTWARE_ICONS[software];
  if (hit) return hit;
  if (software.startsWith("元扫雷")) return { icon: "/images/software/yuansaolei.png", name: "元扫雷" };
  return null;
}

/** 软件名全称（含版本号，2026-10-29 二轮张老师口径）：已知软件「Minesweeper Arbiter 0.52」；
 *  元扫雷库值本身带版本（「元扫雷3.3.4」）不拼 version（version 0.4 是录像格式版本非软件版本）；
 *  未知软件回退原值。
 *  Saolei.wang 的 version 列＝客户端版本（0.3＝格心录制旧版 / 0.4 起＝真实坐标），
 *  走默认拼接展示「Saolei.wang 0.4」 */
function softwareFullName(software: string, version: string): string {
  // 元扫雷：software 本身带版本（「元扫雷3.3.4」），version 列（0.4）是录像格式版本非软件版本，不拼
  if (software.startsWith("元扫雷")) return software.trim();
  const hit = SOFTWARE_ICONS[software];
  if (!hit) return software || "未知软件";
  return version ? `${hit.name} ${version.trim()}` : hit.name;
}

/**
 * 软件图标（2026-10-29）：灰度展示（列表+详情页同口径，三轮定稿）；
 * detail=true 详情页软件名前缀用（无气泡——全名已在旁边文字里）。
 * unknown 时列表灰 ? 占位、详情页不渲染
 */
export function SoftwareIcon({
  software,
  version,
  detail = false,
}: {
  software: string;
  version: string;
  detail?: boolean;
}) {
  const sw = softwareIcon(software);
  if (!sw) {
    return detail ? null : (
      <span className="sw_icon sw--text" data-tip="未知软件" aria-label="未知软件">
        ?
      </span>
    );
  }
  const cls = ["sw_icon", sw.pixel && "sw--pixel", sw.dim && "sw--dim"]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={cls}
      data-tip={detail ? undefined : softwareFullName(software, version)}
      aria-label={detail ? undefined : softwareFullName(software, version)}
    >
      {/* 16px 定长小图标，不值得 next/image；沿用站内 <img> 直出（同 MobileNav 头像） */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={sw.icon} alt="" width={16} height={16} />
    </span>
  );
}

/** 行高亮列（2026-10-15 扩展：排序命中列）。id 列仅在显式排序态（URL 带 order=id，
 *  2026-10-23 升降序切换）才高亮——默认排序（URL 无 order）不高亮（张老师 2026-10-15 口径） */
export type VideoHighlight = VideoListOrder;

/** 升降序双箭头（2026-10-23 张老师需求）：上/下两枚小三角纵向堆叠，当前方向金色、
 *  另一枚暗色；置于 <a> 内部随链接 inline-flex 垂直居中（与文字垂直居中对齐） */
function SortArrows({ dir }: { dir: VideoListDir }) {
  return (
    <span className="sa" aria-hidden="true">
      <i className={`up${dir === "asc" ? " on" : ""}`} />
      <i className={`down${dir === "desc" ? " on" : ""}`} />
    </span>
  );
}

/** 表头排序链接参数（base + 固定筛选参数，order/dir 由表头自组） */
export interface VideoSortSpec {
  base: string;
  params: Record<string, string | number | undefined>;
  order: VideoListOrder;
  /** 当前方向（2026-10-23 升降序切换）：缺省=该列默认方向；显式态（URL 带显式 order，
   *  含 id）才渲染箭头/高亮——默认排序（URL 无 order）保持纯文本表头（张老师口径） */
  dir?: VideoListDir;
  /** URL 是否显式带 order（含 id）：/video 与用户主页直链带 order=id 或 dir 时为 true，
   *  默认进页（无 order 参数）为 false——表头「上传时间」不高亮不渲染箭头 */
  explicit?: boolean;
}

/** 表头（列定义唯一来源，多处共用）。有 sort 时可排序列渲染为链接（排行表头同语言）。
 *  onSort（2026-10-16）：提供时普通左键点击就地客户端排序（preventDefault 不导航），
 *  修饰键点击/中键仍走真实链接（新标签打开该排序的 URL，URL 即状态兜底）。
 *  2026-10-23 升降序切换：onSort 带方向——同列再点反向（箭头高亮换向），切列取该列默认方向。
 *  noSort3bv（2026-10-20 定向视图）：3BV 列禁排序（整列同值无意义），渲染纯文本。
 *  hideIoe（2026-10-28 张老师需求）：首页/用户主页去掉 IOE 列（/video 列表页保持全列） */
export function VideoHead({
  sort,
  onSort,
  noSort3bv,
  hideIoe,
}: {
  sort?: VideoSortSpec;
  onSort?: (order: VideoListOrder, dir: VideoListDir) => void;
  noSort3bv?: boolean;
  hideIoe?: boolean;
}) {
  // 各列排序链接（order/dir 进 URL：显式态才带——默认排序 URL 省略 order）
  function col(order: VideoListOrder, label: string, title: string) {
    if (!sort) return label;
    const explicit = sort.explicit ?? (!!sort.order && sort.order !== "id");
    // 命中判定：显式态（含 order=id 直链）当前列即命中；默认态 id 列不高亮（张老师口径）
    const hit = explicit ? sort.order === order : sort.order === order && order !== "id";
    // 链接方向：命中列=反向（再点切换）；未命中列=该列默认方向
    const dir: VideoListDir = hit
      ? (sort.dir ?? VIDEO_LIST_DEFAULT_DIR[order]) === "asc"
        ? "desc"
        : "asc"
      : VIDEO_LIST_DEFAULT_DIR[order];
    const href = buildUrl(sort.base, {
      ...sort.params,
      order: order === "id" && !hit ? undefined : order,
      // 显式 id 直链回默认（去掉 order 参数）；其余带方向（默认方向省参保持旧链接兼容）
      dir: order !== "id" && dir !== VIDEO_LIST_DEFAULT_DIR[order] ? dir : undefined,
      page: undefined,
    });
    return (
      <Link
        href={href}
        className={hit ? "current" : ""}
        title={title}
        onClick={
          onSort
            ? (e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onSort(order, dir);
              }
            : undefined
        }
      >
        {label}
        {hit && <SortArrows dir={sort.dir ?? VIDEO_LIST_DEFAULT_DIR[order]} />}
      </Link>
    );
  }
  return (
    <thead>
      <tr>
        <th>上传者</th>
        {/* 软件（2026-10-29 张老师需求）：级别列之前，图标+hover 全名气泡（VideoRowLine 同步） */}
        <th className="c sw">软件</th>
        <th>级别</th>
        <th>{col("time", "成绩", "按成绩排列（快在前）")}</th>
        {/* 定向视图（3BV 精确筛选）下 3BV 整列同值，禁排序纯文本（2026-10-20）。
            th 上的 bv/bvs/ioe/stnb 区分类名（2026-10-28）：移动端 #video/#user_videos
            需要单独放行 3BV/s 列（globals.css 媒体查询按类名定向隐藏） */}
        <th className="c bv">{noSort3bv ? "3BV" : col("3bv", "3BV", "按 3BV 排列（大在前）")}</th>
        <th className="c bvs">{col("3bvs", "3BV/s", "按 3BV/s 排列（快在前）")}</th>
        {/* 2026-10-20 张老师需求：新增 IOE（效率）/STNB（判雷）指标列，可点击排序；
            2026-10-28 hideIoe（张老师需求）：首页/用户主页不输出 IOE 列 */}
        {!hideIoe && <th className="c ioe">{col("ioe", "IOE", "按效率 IOE 排列（大在前）")}</th>}
        <th className="c stnb">{col("stnb", "STNB", "按判雷 STNB 排列（大在前）")}</th>
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
        {/* 2026-09-26 张老师要求：上传时间移到最右列；2026-10-15 可点击；2026-10-23 纳入
            升降序切换（显式态可高亮+箭头，默认倒序最新在前 → 再点转正序最早在前） */}
        <th>{col("id", "上传时间", "按上传时间排列（默认倒序，点击切换升降序）")}</th>
      </tr>
    </thead>
  );
}

/** 单行（<tr>），列宽/配色见 globals.css 的 .video_table
 *  highlight：排序命中列整列黄（2026-09-27 起按成绩/按3BV/s，2026-10-15 扩展全部排序列；
 *  默认排序（上传时间）不高亮——张老师要求）。
 *  hideIoe（2026-10-28）：与 VideoHead 同开关——不输出 IOE 单元格（首页/用户主页） */
export function VideoRowLine({
  video: v,
  highlight,
  hideIoe,
}: {
  video: VideoListItem;
  highlight?: VideoHighlight;
  hideIoe?: boolean;
}) {
  const scores = videoScores(v.board3bv, v.realTime, v.level as VideoLevel);
  const lvCls = LEVEL_CLS[v.level as VideoLevel] ?? "";
  return (
    <tr>
      <td className="name">
        {v.author ? (
          <>
            {/* 2026-09-24 张老师要求：性别图标与动态行同尺寸（8x8 small），用户名可点击进个人主页 */}
            <AvatarCell id={v.author.id} name={v.author.chineseName} englishName={v.author.englishName} sex={v.author.sex} gender="small" link />
            <TitleBadge title={v.authorTitle} classic={v.authorClassic} link />
          </>
        ) : (
          <span className="avatar_link">?</span>
        )}
      </td>
      {/* 软件列（2026-10-29）：与表头同步，位置=级别列之前；二轮起灰度+带版本气泡 */}
      <td className="c sw">
        <SoftwareIcon software={v.software} version={v.version} />
      </td>
      <td className={`level ${lvCls}`}>{LEVEL_NAMES[v.level as VideoLevel] ?? v.level}</td>
      <td className={`score ${lvCls}${highlight === "time" ? " current" : ""}`}>
        <Link href={`/video/${v.id}`} target="_blank" prefetch={false} title="点击查看录像">
          {scoreTime(scores.time)}
        </Link>
        {v.noflag && (
          <span className="nf" title="仅用左键点击完成游戏，全程不用右键标雷">
            NF
          </span>
        )}
        {/* 2026-10-23 张老师需求：已审核（status=20）录像成绩后加绿色 ✓ 下标
            （待审 10 放行进前台后区分已审/未审；NF 标记存在时排在 NF 后面） */}
        {v.status === 20 && (
          <span className="reviewed" title="已通过审核">
            ✓
          </span>
        )}
        {/* 2026-10-23 张老师需求：屏蔽盘（status=0，仅本人主页可见）同位置红 ✕
            （替代 ✓ 的位置语义：此录像已被屏蔽，详情页可自助删除） */}
        {v.status === 0 && (
          <span className="banned" title="该录像已被屏蔽">
            ✕
          </span>
        )}
      </td>
      {/* 本BV标记（2026-10-28 张老师需求）：首收=小数点角标 / PB=小数点角标（黄色），
          绝对定位在数字右侧不占排版；hover 数字高亮 + 气泡（样式见 globals.css .bv_marked）。
          20:44 张老师两轮定稿：角标统一为小数点字符（PB 不再用感叹号），颜色统一不分级别——
          新BV=绿 / 新PB=黄（span 上的 first/pb 类控制）。
          first_bv 与 pb_bv 互斥（首盘无旧纪录可破，上传侧保证） */}
      <td className={`c_3bvs bv c${highlight === "3bv" ? " current" : ""}`}>
        {v.firstBv || v.pbBv ? (
          <span
            className={`bv_marked ${v.pbBv ? "pb" : "first"}`}
            data-tip={v.firstBv ? "首次收集本BV" : "本BV最新个人纪录"}
            aria-label={v.firstBv ? "首次收集本BV" : "本BV最新个人纪录"}
          >
            {v.board3bv}
            <i className="mk" aria-hidden="true">.</i>
          </span>
        ) : (
          v.board3bv
        )}
      </td>
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
          hover 气泡说明指标含义。hideIoe（2026-10-28）：首页/用户主页不输出 */}
      {!hideIoe && (
        <td className={`c_3bvs ioe c${highlight === "ioe" ? " current" : ""}`}>
          {v.ioe != null ? (
            <span data-tip="IOE 效率：每点击换回的 3BV" aria-label="IOE 效率">
              {v.ioe.toFixed(3)}
            </span>
          ) : (
            <span title="该录像暂无分析数据">-</span>
          )}
        </td>
      )}
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
