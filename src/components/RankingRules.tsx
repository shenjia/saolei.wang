// 各排行榜页底「排行规则」标准板块（2026-10-14 张老师要求：所有排行该列规则的都列上，
// 独立板块）。标准 .box + h2 + ol（1/2/3/4…）——与 BV 榜已确认的形态一致；各页只传规则
// 条目（可带 <b> 小标题），样式类 .rank_rules 见 globals.css。

import type { ReactNode } from "react";

export function RankingRules({ title, items }: { title: string; items: ReactNode[] }) {
  return (
    <div className="box rank_rules">
      <h2>{title}</h2>
      <ol>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
    </div>
  );
}
