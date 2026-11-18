// 账号中心页头（移植 views/account/_header）：标题 + 子导航
// 2026-11-18 23:06 张老师：隐私设置提为独立页（/account/privacy），子导航加入口；
// active 传当前路径段高亮对应项（legacy .nav li.active>a 金色）。

import Link from "next/link";

const NAV_ITEMS: [string, string][] = [
  ["profile", "修改资料"],
  ["email", "绑定邮箱"],
  ["password", "修改密码"],
  ["privacy", "隐私设置"],
];

export function AccountHeader({ active }: { active?: string }) {
  return (
    <>
      <div className="nav">
        <Link href="/account">
          <h1>账户设置</h1>
        </Link>
        <ul id="box_nav">
          {NAV_ITEMS.map(([key, label]) => (
            <li key={key} className={active === key ? "active" : undefined}>
              <Link href={`/account/${key}`}>{label}</Link>
            </li>
          ))}
        </ul>
      </div>
      <hr />
    </>
  );
}
