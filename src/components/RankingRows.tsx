// 全级别排行表的共享渲染件（2026-09-24 张老师要求「加载更多」改造时从 RankingTable 抽出）：
// 列定义 / 成绩格 / 升降箭头 / 表头 / 行渲染——客户端（/ranking 加载更多）与
// 服务端（/area 分页 + RankingTable 薄封装）共用，保证两处渲染完全一致。
// 本组件不含 <table> 骨架与数据获取，只负责行与列。
// 2026-10-14 张老师需求：升降列拆出「占位」（deltaCol）与「内容」（showDelta）两个开关——
// 雷界榜切其它排序列时保留空列（表头文字 visibility:hidden 保宽），切级别版式不跳动。

import Link from "next/link";
import type { RankingRow } from "@/lib/queries";
import { scoreTime } from "@/lib/format";
import { INVALID_3BVS_TIP, RANKING_BYS, type RankingBy } from "@/lib/config";
import { RankingName, TitleBadge } from "./Cells";
import { SystemText } from "./SystemText";
import { buildUrl } from "./Pager";

export const RANKING_COLS: { by: RankingBy; label: string; cls: string }[] = [
  { by: "beg_time", label: "初级", cls: "c_beg" },
  { by: "beg_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "int_time", label: "中级", cls: "c_int" },
  { by: "int_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "exp_time", label: "高级", cls: "c_exp" },
  { by: "exp_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "sum_time", label: "总计", cls: "c_sum" },
  { by: "sum_3bvs", label: "3BV/s", cls: "c_3bvs" },
  // 活跃（2026-11-10 张老师要求，地区内页）：7 日活跃值；0=7 日无活跃显示「-」
  { by: "act", label: "活跃", cls: "c_act" },
];

// 雷界/地区榜列宽钉死（2026-10-26 张老师要求：NF 开关/换页/加载更多列宽零变化）。
// table-layout:fixed 下列宽只由 colgroup 决定、与内容无关；各值 ≥ 实测最小内容宽
// （1px 钉宽 + scrollWidth 实测：[71,74,85,33,42,33,39,42,39,42,42,30]），
// 名字列给足 6 字中文名 + 性别图标（实测最长 ~94px）；2026-10-28 张老师再要求收紧
// （118→108，超长名走 ellipsis 兜底），余量由 fixed 布局按比例摊。
// 2026-11-10 张老师要求：活跃列仅地区内页显示——AREA_COL_WIDTHS=雷界 12 列 + 活跃 42；
// 全国/NF 榜（deltaCol 在位）用原 12 列宽。
export const RANKING_COL_WIDTHS = [73, 108, 105, 54, 62, 54, 60, 58, 60, 58, 60, 32];
export const AREA_COL_WIDTHS = [...RANKING_COL_WIDTHS, 42];

// 军衔列预评：服务端（RankingTable）/ API 侧先算好随行传入，客户端零成本渲染
export type TitledRow = RankingRow & { title: string; classic?: { name: string; color: string } | null };

function ScoreCell({
  row,
  col,
  current,
}: {
  row: RankingRow;
  col: (typeof RANKING_COLS)[number];
  current: boolean;
}) {
  const v = row.scores[col.by];
  const isTime = col.by.endsWith("_time");
  // 活跃列（2026-11-10 地区内页）：7 日活跃值，纯数字无录像链接；0=7 日无活跃；
  // 排序命中挂 act_cur 保绿色（2026-11-10 张老师要求：命中列也绿，同活跃指数口径）
  if (col.by === "act") {
    return <td className={`${col.cls}${current ? " current act_cur" : ""}`}>{v ? v : "-"}</td>;
  }
  // hover 按级别变色（2026-10-13 张老师要求，与录像列表同逻辑）：初级绿、中级橙、高级金；
  // 总计列（sum）保持全站 hover 绿
  const lvCls = col.by.startsWith("beg") ? "hv_beg" : col.by.startsWith("int") ? "hv_int" : col.by.startsWith("exp") ? "hv_exp" : "";
  const cls = `${col.cls}${current ? " current" : ""}${lvCls ? ` ${lvCls}` : ""}`;
  // 有初级时间但 3BV 未达限界时，初级 3BV/s=0 是有效零纪录（2026-10-26 口径）；
  // 其他列的 0 仍表示无成绩。
  if (!v && !(col.by === "beg_3bvs" && row.scores.beg_time > 0)) return <td className={cls}>-</td>;
  // 3BV/s 负值 = 3BV 太小不被承认（删除线，对齐 Score3bvs 语义）
  // 2026-11-07 起排行表 3BV/s 显示 3 位小数（张老师要求，与全站时间 3 位小数口径对齐）
  const neg = !isTime && v < 0;
  const text = isTime ? scoreTime(v) : ((neg ? -v : v) / 1000).toFixed(3);
  const videoId = row.videos[col.by];
  // 无效成绩 hover 弹自定义气泡（2026-10-13 张老师要求，同录像详情页文案）；
  // 此时不再挂 <a> 的「点击查看录像」原生 title，免得两种提示叠在一起
  const inner = neg ? (
    <del data-tip={INVALID_3BVS_TIP} aria-label={INVALID_3BVS_TIP}>
      {text}
    </del>
  ) : (
    text
  );
  return (
    <td className={cls}>
      {videoId ? (
        /* prefetch={false}：_blank 新标签页用不上预取缓存（Next 16 源码实证 mountLinkInstance
            不看 target，照发预取请求白吃 nginx 限速配额）——排行页 Link 密度全站最高，是切榜 429 主因 */
        <Link href={`/video/${videoId}`} target="_blank" prefetch={false} title={neg ? undefined : "点击查看录像"}>
          {inner}
        </Link>
      ) : (
        inner
      )}
    </td>
  );
}

/** 升降矢量箭头（2026-09-24 张老师要求：↑/↓ 字符换圆润小三角，颜色继承所在 span） */
export function DeltaArrow({ dir }: { dir: "up" | "down" }) {
  const d = dir === "up" ? "M6 2.2 10.5 10H1.5Z" : "M6 9.8 1.5 2h9Z";
  return (
    <svg className="d_arrow" width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
      <path d={d} fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 一行（含锚点 id_{uid}，供「我在哪里」/搜索定位；hl=定位落地行持续高亮）。
 *  showAct（2026-11-10 张老师要求）：活跃列仅地区内页显示，雷界/NF/进步榜隐藏 */
export function RankingRowLine({
  row,
  by,
  delta,
  showDelta,
  deltaCol,
  hl,
  showAct = false,
}: {
  row: TitledRow;
  /** 排序命中列；null=无成绩列命中（进步榜等非成绩排序场景） */
  by: RankingBy | null;
  delta?: number | null;
  /** 升降列是否渲染内容（仅总计时间排序时有日升降数据） */
  showDelta: boolean;
  /** 升降列是否占位（2026-10-14 张老师需求：雷界榜切其它排序列时保留空列，版式不跳动） */
  deltaCol?: boolean;
  hl?: boolean;
  /** 活跃列显隐（2026-11-10 地区内页专属）：默认隐藏 */
  showAct?: boolean;
}) {
  const cols = showAct ? RANKING_COLS : RANKING_COLS.filter((c) => c.by !== "act");
  return (
    <tr id={`id_${row.id}`} className={hl ? "hl" : undefined}>
      <td className="rank">
        第&nbsp;<em>{row.rank}</em>&nbsp;位
      </td>
      <td className="name">
        {/* 2026-10-23 张老师要求：排行表人名新标签页打开，不破坏榜单浏览位置 */}
        <RankingName id={row.id} name={row.chineseName} englishName={row.englishName} sex={row.sex} avatar={row.avatar} act={row.act} actTip={row.actTip} />
      </td>
      <td className="miltitle">
        <TitleBadge title={row.title} classic={row.classic} link />
      </td>
      {cols.map((c) => (
        <ScoreCell key={c.by} row={row} col={c} current={c.by === by} />
      ))}
      {(showDelta || deltaCol) && (
        <td className="delta">
          {showDelta &&
            (delta === null || delta === undefined ? (
              <span className="new" title="新上榜，暂未超越进榜名次">
                {/* 2026-11-04 张老师要求：显示「新」时前面也带上行箭头（新=未来可提升的起点） */}
                <DeltaArrow dir="up" />新
              </span>
            ) : delta === 0 ? (
              <span className="flat" title="与昨日持平">→</span>
            ) : delta > 0 ? (
              <span className="up" title={`比昨日进步${delta}位`}>
                <DeltaArrow dir="up" />
                {delta}
              </span>
            ) : (
              <span className="down" title={`比昨日下降${-delta}位`}>
                <DeltaArrow dir="down" />
                {-delta}
              </span>
            ))}
        </td>
      )}
    </tr>
  );
}

/** 表头（列头点击切换排序列）。
 *  showAct（2026-11-10）：活跃列仅地区内页显示 */
export function RankingHead({
  by,
  base,
  params,
  showDelta,
  deltaCol,
  showAct = false,
}: {
  by: RankingBy;
  /** 列头排序链接的 base 与固定参数（view/nf、area 等） */
  base: string;
  params: Record<string, string | number | undefined>;
  showDelta: boolean;
  /** 升降列占位（同 RankingRowLine.deltaCol）：占位时表头文字 visibility:hidden 保宽 */
  deltaCol?: boolean;
  /** 活跃列显隐（2026-11-10 地区内页专属）：默认隐藏 */
  showAct?: boolean;
}) {
  const cols = showAct ? RANKING_COLS : RANKING_COLS.filter((c) => c.by !== "act");
  return (
    <thead>
      <tr>
        <th>排名</th>
        <th className="name">姓名</th>
        <th>
          <SystemText />
        </th>
        {cols.map((c) => (
          <th key={c.by}>
            <Link
              href={buildUrl(base, {
                ...params,
                by: c.by === "sum_time" ? undefined : c.by,
                page: undefined,
              })}
              className={c.by === by ? `current${c.by === "act" ? " act_cur" : ""}` : ""}
              title={`按${c.by === "act" ? "活跃值" : c.label === "3BV/s" ? "3BV/s" : c.label + "时间"}排列`}
            >
              {c.label}
            </Link>
          </th>
        ))}
        {(showDelta || deltaCol) && (
          <th className={showDelta ? undefined : "delta_pad"}>升降</th>
        )}
      </tr>
    </thead>
  );
}

/** 空数据占位行（须包在 tbody 内） */
export function RankingEmpty({ showDelta, deltaCol, showAct = false }: { showDelta: boolean; deltaCol?: boolean; showAct?: boolean }) {
  return (
    <tr>
      {/* 基准 11 列（排名/姓名/军衔/8 成绩列）+ 升降 +活跃（2026-11-10 地区内页专属） */}
      <td colSpan={(showDelta || deltaCol ? 1 : 0) + (showAct ? 1 : 0) + 11} style={{ textAlign: "center" }}>
        暂无数据
      </td>
    </tr>
  );
}

/** 便利导出：全部合法排序列（供 API 校验参数用） */
export const ALL_RANKING_BYS = RANKING_BYS;
