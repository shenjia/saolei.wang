// 账号中心页头（2026-11-18 23:28 张老师定：导航统一改筛选器形态）：
// .news_head > h1（点击回 /account）+ .ranking_tabs 筛选 tabs（首页/资料/密码/隐私/邮箱，
// 当前页金色高亮 .current——与首页阶段筛选/排行 tabs 同款样式）。
// 替代原「按钮导航（manage_actions）+ 子导航链接（box_nav）」两种旧形态；
// email 页原「返回」独立头一并统一。active 缺省=首页（/account 自身）。

import Link from "next/link";

const NAV_ITEMS: [string, string][] = [
  ["", "首页"],
  ["profile", "资料"],
  ["password", "密码"],
  ["privacy", "隐私"],
  ["email", "邮箱"],
];

export function AccountHeader({ active = "" }: { active?: string }) {
  return (
    <div className="news_head account_head">
      {/* h1 点击回账户设置首页（页内标题语义与跳转兼顾） */}
      <h1>
        <Link href="/account">账户设置</Link>
      </h1>
      <div className="news_tabs ranking_tabs account_tabs">
        {NAV_ITEMS.map(([key, label]) =>
          key === active ? (
            <span key={key || "home"} className="current">
              {label}
            </span>
          ) : (
            <Link key={key || "home"} href={`/account/${key}`}>
              {label}
            </Link>
          )
        )}
      </div>
    </div>
  );
}
