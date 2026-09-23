// 排行导航条（2008 编排：左侧榜别切换 + 右侧「我在哪里?」查找定位，2026-09-23 张老师要求）
// 供 /ranking /grow /area /click 共用；人界/神界榜按张老师要求取消

import Link from "next/link";

export type RankingView = "all" | "nf" | "grow" | "area" | "click";

const TABS: { key: RankingView; label: string; href: string }[] = [
  { key: "all", label: "雷界排行", href: "/ranking" },
  { key: "nf", label: "NF", href: "/ranking?view=nf" },
  { key: "grow", label: "进步", href: "/grow" },
  { key: "area", label: "地区", href: "/area" },
  { key: "click", label: "人气", href: "/click" },
];

export function RankingNav({ current, by }: { current: RankingView; by?: string }) {
  return (
    <div className="ranking_nav">
      <div className="ranking_tabs">
        {TABS.map((t) =>
          t.key === current ? (
            <span key={t.key} className="current">
              {t.label}
            </span>
          ) : (
            <Link key={t.key} href={t.href}>
              {t.label}
            </Link>
          )
        )}
      </div>
      {(current === "all" || current === "nf") && (
        <form className="goto_form" action="/ranking/whereami" method="get">
          <input type="hidden" name="view" value={current} />
          {by && <input type="hidden" name="by" value={by} />}
          <input type="text" name="name" size={8} maxLength={12} placeholder="姓名" title="按姓名查找" />
          <input type="text" name="id" size={4} maxLength={7} placeholder="ID" title="按 ID 查找" />
          <button type="submit">我在哪里?</button>
        </form>
      )}
    </div>
  );
}
