// 后台侧栏导航（2026-09-24）
// 分组：概览 / 内容 / 玩家 / 运营。待审录像/头像/论坛/反作弊数作为红点角标（服务端传入）。
// 2026-10-27 用户组入口合并进「玩家管理」（?group= 筛选），独立入口移除；
// 两组新成员 badge 合并挂「玩家管理」项（差值求和，算不出退化为红点）。

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminUserMenu } from "./AdminUserMenu";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  badgeKey?: "pending" | "avatar" | "bbs" | "cheat";
  /** 用户组 badge（合并挂玩家管理：两组差值求和） */
  groupBadge?: boolean;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "概览",
    items: [
      { href: "/admin", label: "仪表盘", icon: "📊" },
      { href: "/admin/stats", label: "数据分析", icon: "📈" },
      { href: "/admin/practice", label: "练习数据", icon: "🎮" },
    ],
  },
  {
    title: "内容",
    items: [
      { href: "/admin/review", label: "录像审核", icon: "✅", badgeKey: "pending" },
      { href: "/admin/videos", label: "录像管理", icon: "🎬" },
      { href: "/admin/comments", label: "评论管理", icon: "💬" },
      { href: "/admin/bbs", label: "论坛管理", icon: "💭", badgeKey: "bbs" },
      { href: "/admin/news", label: "动态管理", icon: "📰" },
      { href: "/admin/messages", label: "站内信广播", icon: "✉️" },
    ],
  },
  {
    title: "玩家",
    items: [
      { href: "/admin/users", label: "玩家管理", icon: "👥", groupBadge: true },
      { href: "/admin/cheat", label: "反作弊复核", icon: "🚨", badgeKey: "cheat" },
      { href: "/admin/ipgroups", label: "同 IP 账号组", icon: "🔗" },
      { href: "/admin/avatars", label: "头像审核", icon: "🖼", badgeKey: "avatar" },
    ],
  },
  {
    title: "运营",
    items: [
      { href: "/admin/rank", label: "排行与荣誉", icon: "🏆" },
      { href: "/admin/star", label: "每日一星", icon: "⭐" },
      { href: "/admin/apikeys", label: "API Key", icon: "🔑" },
      { href: "/admin/logs", label: "操作日志", icon: "🗂" },
      { href: "/admin/system", label: "系统信息", icon: "⚙️" },
    ],
  },
];

// ---------- 用户组 badge（localStorage 已读基线对比，2026-10-27） ----------
//
// 服务端每次渲染传「组人数 + 组内最新加入时刻」；浏览器与 localStorage 基线（admin_group_seen_v1）对比：
// · 首次见到该组（无基线）：静默记录基线（时刻+人数），不亮 badge——新浏览器/清缓存不轰炸；
// · 有新成员（最新加入时刻 > 基线时刻）：badge 数字 = 现人数 − 基线人数；人数算不出差值时退化为红点（数字省略）；
// · 只有成员移出（时刻没变、人数变少）：不亮（移除不是新闻）；
// · 进入玩家管理对应组视图（?group=）→ GroupSeenMark 刷新该组基线并广播 admin-group-seen → badge 即时消失。
//   两组（trusted/lowtrust）差值合并显示在「玩家管理」项上。

const LS_KEY = "admin_group_seen_v1";

type GroupKey = "trusted" | "lowtrust";

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export interface GroupBadgeInput {
  count: number;
  maxJoin: number;
}

/** 计算某组的 badge 值：null=不亮；0=红点（有变化但人数差算不出）；>0=新增人数 */
function computeBadge(key: GroupKey, g: GroupBadgeInput, seen: Record<string, number>): number | null {
  if (seen[key] === undefined) return null; // 首次：不亮（由初始化写基线）
  if (g.maxJoin <= seen[key]) return null; // 没有新成员
  const baseCount = seen[key + "_c"];
  if (baseCount === undefined || g.count <= baseCount) return 0; // 差值算不出/变少 → 红点
  return g.count - baseCount;
}

/** 两组 diff 合并：null（都不亮）｜>0（数字和）｜0（任一红点且无数字可显） */
function mergeGroupDiff(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  const sum = Math.max(a ?? 0, 0) + Math.max(b ?? 0, 0);
  return sum > 0 ? sum : 0;
}

export function AdminSidebar({
  badges,
  user,
  groupBadges,
}: {
  badges: { pending: number; avatar: number; bbs: number; cheat: number };
  user: { uid: number; name: string; administrator: boolean };
  /** 用户组 badge 信号（服务端 layout 查询；旧调用方缺省 = 恒不亮，向后兼容） */
  groupBadges?: Record<GroupKey, GroupBadgeInput>;
}) {
  const pathname = usePathname();
  const [groupDiff, setGroupDiff] = useState<number | null>(null);

  // badge 对比 + 首次基线初始化 + 监听组视图已读事件
  useEffect(() => {
    if (!groupBadges) return;
    const recompute = () => {
      const seen = readSeen();
      setGroupDiff(
        mergeGroupDiff(
          computeBadge("trusted", groupBadges.trusted, seen),
          computeBadge("lowtrust", groupBadges.lowtrust, seen)
        )
      );
    };
    // 首次：无基线则静默写入（时刻+人数），下次对比才有意义
    const seen = readSeen();
    let changed = false;
    for (const key of ["trusted", "lowtrust"] as const) {
      if (seen[key] === undefined) {
        seen[key] = groupBadges[key].maxJoin;
        seen[key + "_c"] = groupBadges[key].count;
        changed = true;
      }
    }
    if (changed) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(seen));
      } catch {
        /* 隐私模式等写入失败——badge 退化为不亮，无害 */
      }
    }
    recompute();
    const onSeen = () => recompute();
    window.addEventListener("admin-group-seen", onSeen);
    return () => window.removeEventListener("admin-group-seen", onSeen);
  }, [groupBadges]);

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(href + "/");

  return (
    <aside className="admin_side">
      {/* 品牌区（2026-10-22 张老师要求）：换成与前台统一的 LOGO 与站名——
          icon.svg +「扫雷网」（前台站名金 #fdc61a）+ Saolei.wang，点击回首页。
          同页跳转（新标签需求由底部「查看网站」承担） */}
      <div className="admin_brand_row">
        <Link href="/" className="admin_brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" />
          <span>
            <b>扫雷网</b>
            <em>Saolei.wang</em>
          </span>
        </Link>
        <AdminUserMenu uid={user.uid} name={user.name} administrator={user.administrator} />
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
                  {n > 0 && <span className="n">{n}</span>}
                  {it.groupBadge && groupDiff !== null && groupDiff > 0 && <span className="n">{groupDiff}</span>}
                  {it.groupBadge && groupDiff === 0 && <span className="n dot" />}
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
