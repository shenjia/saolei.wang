// 玩家管理顶部 tab 条（客户端，2026-10-27）
// · 独立入口合并进玩家管理后，侧栏「玩家管理」红点是两组（可信/低信任）合并的，
//   落地页却在「全部玩家」——不知道该看哪个 tab（张老师反馈）。
// · 这里在 tab 按钮上挂**各组自己的** badge（数字，算不出差值按 1 显示——
//   2026-10-27 张老师定恒显数字，与侧栏两组之和口径对齐），复用同一套
//   localStorage admin_group_seen_v1 基线对比，直接指明新成员在哪个组；
//   进入对应组 tab（UserGroupTable 挂载）刷新基线并广播 admin-group-seen → 本组件同步消失。
// · 服务端把 layout 同源的两组信号（count/maxJoin）透传进来，避免二次查询。

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const LS_KEY = "admin_group_seen_v1";

type GroupKey = "trusted" | "lowtrust";

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export function UserGroupTabs({
  tab,
  groupBadges,
}: {
  /** 当前激活 tab：all / trusted / lowtrust / ip（URL ?group=） */
  tab: "all" | "trusted" | "lowtrust" | "ip";
  /** 两组 badge 信号（layout 同源查询透传） */
  groupBadges: Record<GroupKey, { count: number; maxJoin: number }>;
}) {
  const [diffs, setDiffs] = useState<Record<GroupKey, number | null>>({ trusted: null, lowtrust: null });

  useEffect(() => {
    const recompute = () => {
      const seen = readSeen();
      const calc = (key: GroupKey, g: { count: number; maxJoin: number }): number | null => {
        if (seen[key] === undefined) return null; // 首次无基线：不亮（侧栏初始化时会写基线）
        if (g.maxJoin <= seen[key]) return null; // 没有新成员
        const baseCount = seen[key + "_c"];
        if (baseCount === undefined || g.count <= baseCount) return 0; // 差值算不出/变少 → 渲染层按 1 显
        return g.count - baseCount;
      };
      setDiffs({ trusted: calc("trusted", groupBadges.trusted), lowtrust: calc("lowtrust", groupBadges.lowtrust) });
    };
    recompute();
    window.addEventListener("admin-group-seen", recompute);
    return () => window.removeEventListener("admin-group-seen", recompute);
  }, [groupBadges]);

  // 2026-11-13 张老师定：四 tab 各自主题色（金/绿/玫瑰红/青），选中或 hover 按色渲染
  const tabs: { key: "all" | GroupKey | "ip"; label: string; cls: string }[] = [
    { key: "all", label: "全部玩家", cls: "ugt_all" },
    { key: "trusted", label: "可信用户组", cls: "ugt_trusted" },
    { key: "lowtrust", label: "低信任用户组", cls: "ugt_lowtrust" },
    { key: "ip", label: "同 IP 账号组", cls: "ugt_ip" },
  ];

  return (
    <div className="admin_filterbar">
      {tabs.map(({ key, label, cls }) => (
        <Link
          key={key}
          href={key === "all" ? "/admin/users" : `/admin/users?group=${key}`}
          className={`admin_btn ${cls}${tab === key ? " on" : ""}`}
        >
          {label}
          {key !== "all" && key !== "ip" && diffs[key] !== null && (
            <span className="ug_tab_badge" title="有新成员加入，点进去查看（新行会加亮）">
              {diffs[key]! || 1}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
