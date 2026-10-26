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
import { TitleBadge } from "./Cells";
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
];

// 雷界/地区榜列宽钉死（2026-10-26 张老师要求：NF 开关/换页/加载更多列宽零变化）。
// table-layout:fixed 下列宽只由 colgroup 决定、与内容无关；各值 ≥ 实测最小内容宽
// （1px 钉宽 + scrollWidth 实测：[71,74,85,33,42,33,39,42,39,42,42,30]），
// 名字列给足 6 字中文名 + 性别图标（实测最长 ~94px），余量由 fixed 布局按比例摊。
export const RANKING_COL_WIDTHS = [73, 130, 105, 54, 62, 54, 60, 58, 60, 58, 60, 32];

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
  // hover 按级别变色（2026-10-13 张老师要求，与录像列表同逻辑）：初级绿、中级橙、高级金；
  // 总计列（sum）保持全站 hover 绿
  const lvCls = col.by.startsWith("beg") ? "hv_beg" : col.by.startsWith("int") ? "hv_int" : col.by.startsWith("exp") ? "hv_exp" : "";
  const cls = `${col.cls}${current ? " current" : ""}${lvCls ? ` ${lvCls}` : ""}`;
  // 有初级时间但 3BV 未达限界时，初级 3BV/s=0 是有效零纪录（2026-10-26 口径）；
  // 其他列的 0 仍表示无成绩。
  if (!v && !(col.by === "beg_3bvs" && row.scores.beg_time > 0)) return <td className={cls}>-</td>;
  // 3BV/s 负值 = 3BV 太小不被承认（删除线，对齐 Score3bvs 语义）
  // 排行表内 3BV/s 按 2008 版 FormatNumber(...,2) 显示两位小数
  const neg = !isTime && v < 0;
  const text = isTime ? scoreTime(v) : ((neg ? -v : v) / 1000).toFixed(2);
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

/** 一行（含锚点 id_{uid}，供「我在哪里」/搜索定位；hl=定位落地行持续高亮） */
export function RankingRowLine({
  row,
  by,
  delta,
  showDelta,
  deltaCol,
  hl,
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
}) {
  return (
    <tr id={`id_${row.id}`} className={hl ? "hl" : undefined}>
      <td className="rank">
        第&nbsp;<em>{row.rank}</em>&nbsp;位
      </td>
      <td className="name">
        {/* 2026-10-23 张老师要求：排行表人名新标签页打开，不破坏榜单浏览位置 */}
        <Link href={`/user/${row.id}`} target="_blank" prefetch={false} title="点击查看个人信息">
          {row.chineseName}
        </Link>
        <span className={`gender ${row.sex ? "male" : "female"} small`}></span>
      </td>
      <td className="miltitle">
        <TitleBadge title={row.title} classic={row.classic} link />
      </td>
      {RANKING_COLS.map((c) => (
        <ScoreCell key={c.by} row={row} col={c} current={c.by === by} />
      ))}
      {(showDelta || deltaCol) && (
        <td className="delta">
          {showDelta &&
            (delta === null || delta === undefined ? (
              <span className="new" title="昨日新上榜">新</span>
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

/** 表头（列头点击切换排序列） */
export function RankingHead({
  by,
  base,
  params,
  showDelta,
  deltaCol,
}: {
  by: RankingBy;
  /** 列头排序链接的 base 与固定参数（view/nf、area 等） */
  base: string;
  params: Record<string, string | number | undefined>;
  showDelta: boolean;
  /** 升降列占位（同 RankingRowLine.deltaCol）：占位时表头文字 visibility:hidden 保宽 */
  deltaCol?: boolean;
}) {
  return (
    <thead>
      <tr>
        <th>排名</th>
        <th>姓名</th>
        <th>
          <SystemText />
        </th>
        {RANKING_COLS.map((c) => (
          <th key={c.by}>
            <Link
              href={buildUrl(base, {
                ...params,
                by: c.by === "sum_time" ? undefined : c.by,
                page: undefined,
              })}
              className={c.by === by ? "current" : ""}
              title={`按${c.label === "3BV/s" ? "3BV/s" : c.label + "时间"}排列`}
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
export function RankingEmpty({ showDelta, deltaCol }: { showDelta: boolean; deltaCol?: boolean }) {
  return (
    <tr>
      <td colSpan={showDelta || deltaCol ? 12 : 11} style={{ textAlign: "center" }}>
        暂无数据
      </td>
    </tr>
  );
}

/** 便利导出：全部合法排序列（供 API 校验参数用） */
export const ALL_RANKING_BYS = RANKING_BYS;
