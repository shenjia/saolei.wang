// 各排行榜页底「排行规则」标准板块（2026-10-14 张老师要求：所有排行该列规则的都列上，
// 独立板块）。标准 .box + h2 + ol（1/2/3/4…）——与 BV 榜已确认的形态一致；各页只传规则
// 条目（可带 <b> 小标题），样式类 .rank_rules 见 globals.css。
// footer（2026-10-15 张老师要求）：板块内底部扩展位——「如何加入排行？」按钮从翻页
// 控件右侧移到这里（登录未入榜时显示，各页自行判条件传入）。
// 配色（2026-10-15 张老师定）：金色只给「小标题：」——条目里的 <b> 标签就是小标题
// （渲染成「统计口径：…」的形态，冒号在各页文案里）；正文一律灰色，数字用亮灰 <i>。

import Link from "next/link";
import type { ReactNode } from "react";

/** 规则正文里的数字（亮灰显示，2026-10-15 张老师定：所有数字全用亮灰，金只留小标题） */
export function Num({ children }: { children: ReactNode }) {
  return <i>{children}</i>;
}

/** 「如何加入排行？」按钮（2026-10-15 张老师要求：从翻页控件右侧移入各排行规则板块
    底部；登录未入榜时由页面层判条件传入 RankingRules.footer） */
export function JoinRankingHelp() {
  return (
    <Link href="/page/help" className="button small join_btn" title="了解如何上传录像、加入排行榜">
      如何加入排行？
    </Link>
  );
}

export function RankingRules({
  title,
  items,
  footer,
}: {
  title: string;
  items: ReactNode[];
  /** 板块内底部扩展位（如「如何加入排行？」按钮） */
  footer?: ReactNode;
}) {
  return (
    <div className="box rank_rules">
      <h2>{title}</h2>
      <ol>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
      {footer}
    </div>
  );
}
