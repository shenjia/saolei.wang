// 后台侧栏导航（2026-09-24）
// 分组：概览 / 内容 / 玩家 / 运营。待审录像数作为红点角标（服务端传入，避免客户端再请求一次）。

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  badgeKey?: "pending";
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "概览",
    items: [
      { href: "/admin", label: "仪表盘", icon: "📊" },
      { href: "/admin/stats", label: "数据分析", icon: "📈" },
    ],
  },
  {
    title: "内容",
    items: [
      { href: "/admin/review", label: "审核管理", icon: "✅", badgeKey: "pending" },
      { href: "/admin/videos", label: "录像管理", icon: "🎬" },
      { href: "/admin/comments", label: "评论管理", icon: "💬" },
      { href: "/admin/bbs", label: "论坛管理", icon: "💭" },
      { href: "/admin/news", label: "动态管理", icon: "📰" },
      { href: "/admin/messages", label: "站内信广播", icon: "✉️" },
    ],
  },
  {
    title: "玩家",
    items: [{ href: "/admin/users", label: "玩家管理", icon: "👥" }],
  },
  {
    title: "运营",
    items: [
      { href: "/admin/rank", label: "排行与荣誉", icon: "🏆" },
      { href: "/admin/logs", label: "操作日志", icon: "🗂" },
      { href: "/admin/system", label: "系统信息", icon: "⚙️" },
    ],
  },
];

export function AdminSidebar({ badges }: { badges: { pending: number } }) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(href + "/");

  return (
    <aside className="admin_side">
      <div className="admin_brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" />
        <span>
          <b>扫雷网后台</b>
          <em>Saolei.wang Admin</em>
        </span>
      </div>

      <nav className="admin_nav">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="admin_nav_group">{g.title}</div>
            {g.items.map((it) => {
              const n = it.badgeKey ? badges[it.badgeKey] : 0;
              return (
                <Link key={it.href} href={it.href} className={isActive(it.href) ? "on" : undefined}>
                  <i>{it.icon}</i>
                  {it.label}
                  {n > 0 && <span className="n">{n > 99 ? "99+" : n}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="admin_side_foot">
        <a href="/" target="_blank" rel="noopener noreferrer">
          🌐 查看网站
        </a>
        <br />
        <a href="/page/history" target="_blank" rel="noopener noreferrer">
          📜 更新历史
        </a>
      </div>
    </aside>
  );
}
