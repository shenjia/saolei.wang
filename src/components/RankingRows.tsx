// 全级别排行表的共享渲染件（2026-09-24 张老师要求「加载更多」改造时从 RankingTable 抽出）：
// 列定义 / 成绩格 / 升降箭头 / 表头 / 行渲染——客户端（/ranking 加载更多）与
// 服务端（/area 分页 + RankingTable 薄封装）共用，保证两处渲染完全一致。
// 本组件不含 <table> 骨架与数据获取，只负责行与列。

import Link from "next/link";
import type { RankingRow } from "@/lib/queries";
import { scoreTime } from "@/lib/format";
import { RANKING_BYS, type RankingBy } from "@/lib/config";
import { TitleBadge } from "./Cells";
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

// 军衔列预评：服务端（RankingTable）/ API 侧先算好随行传入，客户端零成本渲染
export type TitledRow = RankingRow & { title: string };

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
  const cls = `${col.cls}${current ? " current" : ""}`;
  if (!v) return <td className={cls}>-</td>;
  // 3BV/s 负值 = 3BV 太小不被承认（删除线，对齐 Score3bvs 语义）
  // 排行表内 3BV/s 按 2008 版 FormatNumber(...,2) 显示两位小数
  const neg = !isTime && v < 0;
  const text = isTime ? scoreTime(v) : ((neg ? -v : v) / 1000).toFixed(2);
  const videoId = row.videos[col.by];
  const inner = neg ? <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">{text}</del> : text;
  return (
    <td className={cls}>
      {videoId ? (
        <Link href={`/video/${videoId}`} target="_blank" title="点击查看录像">
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

/** 一行（含锚点 id_{uid}，供「我在哪里」定位） */
export function RankingRowLine({
  row,
  by,
  delta,
  showDelta,
}: {
  row: TitledRow;
  by: RankingBy;
  delta?: number | null;
  showDelta: boolean;
}) {
  return (
    <tr id={`id_${row.id}`}>
      <td className="rank">
        第&nbsp;<em>{row.rank}</em>&nbsp;位
      </td>
      <td className="name">
        <Link href={`/user/${row.id}`} target="_blank" title="点击查看个人信息">
          {row.chineseName}
        </Link>
        <span className={`gender ${row.sex ? "male" : "female"} small`}></span>
      </td>
      <td className="miltitle">
        <TitleBadge title={row.title} link />
      </td>
      {RANKING_COLS.map((c) => (
        <ScoreCell key={c.by} row={row} col={c} current={c.by === by} />
      ))}
      {showDelta && (
        <td className="delta">
          {delta === null || delta === undefined ? (
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
          )}
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
}: {
  by: RankingBy;
  /** 列头排序链接的 base 与固定参数（view/nf、area 等） */
  base: string;
  params: Record<string, string | number | undefined>;
  showDelta: boolean;
}) {
  return (
    <thead>
      <tr>
        <th>排名</th>
        <th>姓名</th>
        <th>军衔</th>
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
        {showDelta && <th>升降</th>}
      </tr>
    </thead>
  );
}

/** 空数据占位行（须包在 tbody 内） */
export function RankingEmpty({ showDelta }: { showDelta: boolean }) {
  return (
    <tr>
      <td colSpan={showDelta ? 12 : 11} style={{ textAlign: "center" }}>
        暂无数据
      </td>
    </tr>
  );
}

/** 便利导出：全部合法排序列（供 API 校验参数用） */
export const ALL_RANKING_BYS = RANKING_BYS;
