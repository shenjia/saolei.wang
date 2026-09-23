// 排行导航条（2008 编排：左侧榜别切换 + 右侧查找定位，2026-09-23 张老师要求；
// 2026-09-24 三轮调整：双输入框合并为单个圆角搜索框——矢量放大镜 + placeholder「姓名或ID」，
// 提交即定位；「我在哪里」按钮从导航条移除，登录态改由底部加载更多右侧提供）

import Link from "next/link";

export type RankingView = "all" | "nf" | "grow" | "area" | "click" | "world";

const TABS: { key: RankingView; label: string; href: string }[] = [
  { key: "all", label: "雷界排行", href: "/ranking" },
  { key: "nf", label: "NF", href: "/ranking?view=nf" },
  { key: "grow", label: "进步", href: "/grow" },
  { key: "area", label: "地区", href: "/area" },
  { key: "click", label: "人气", href: "/click" },
  { key: "world", label: "世界", href: "/ranking?view=world" },
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
        <form className="goto_form" action="/ranking/whereami" method="get" role="search">
          <input type="hidden" name="view" value={current} />
          {by && <input type="hidden" name="by" value={by} />}
          <span className="goto_search">
            <svg className="goto_icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
              <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <line x1="9.4" y1="9.4" x2="13" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              name="q"
              maxLength={12}
              placeholder="姓名或ID"
              title="输入姓名或用户 ID，定位到排行榜中的位置"
            />
          </span>
          <button type="submit">查找</button>
        </form>
      )}
    </div>
  );
}
