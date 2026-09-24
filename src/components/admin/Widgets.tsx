// 后台通用展示件（服务端组件，2026-09-24）
// 只做排版与语义标签，不含交互——交互件在 AdminAction.tsx / AdminFilters.tsx / Charts.tsx。

import Link from "next/link";
import { Sparkline } from "./Charts";
import { VIDEO_STATUS_NAMES } from "@/lib/config";

export function AdminCard({
  title,
  more,
  tight,
  children,
}: {
  title?: React.ReactNode;
  more?: React.ReactNode;
  /** 表格类内容去掉内边距，让表头贴边 */
  tight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="admin_card">
      {title !== undefined && (
        <h2>
          {title}
          {more && <span className="more">{more}</span>}
        </h2>
      )}
      <div className={`admin_card_body${tight ? " tight" : ""}`}>{children}</div>
    </div>
  );
}

/** KPI 指标卡 */
export function Kpi({
  label,
  value,
  unit,
  foot,
  tone = "green",
  trend,
  href,
}: {
  label: string;
  value: string | number;
  unit?: string;
  foot?: React.ReactNode;
  tone?: "green" | "yellow" | "orange" | "cyan" | "purple" | "red" | "grey";
  /** 近 30 天走势（有则右下角画迷你折线） */
  trend?: number[];
  href?: string;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value">
        {typeof value === "number" ? value.toLocaleString("zh-CN") : value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="foot" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }}>{foot}</span>
        {trend && trend.length > 1 && (
          <Sparkline values={trend} color={TONE_COLORS[tone]} />
        )}
      </div>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={`admin_kpi ${tone}`} style={{ display: "block" }}>
        {body}
      </Link>
    );
  }
  return <div className={`admin_kpi ${tone}`}>{body}</div>;
}

const TONE_COLORS: Record<string, string> = {
  green: "#a6e22e",
  yellow: "#e6db74",
  orange: "#f79646",
  cyan: "#66d9ef",
  purple: "#ae81ff",
  red: "#f92672",
  grey: "#6c6c61",
};

/** 录像状态标签 */
export function StatusTag({ status }: { status: number }) {
  const tone = status === 20 ? "ok" : status === 10 ? "wait" : "bad";
  return <span className={`admin_tag ${tone}`}>{VIDEO_STATUS_NAMES[status] ?? status}</span>;
}

/** 级别标签 */
export function LevelTag({ level }: { level: string }) {
  const names: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
  const tone = level === "beg" ? "plain" : level === "int" ? "info" : "warn";
  return <span className={`admin_tag ${tone}`}>{names[level] ?? level}</span>;
}

/** 玩家角色标签 */
export function RoleTag({ role }: { role: number }) {
  if (role === 100) return <span className="admin_tag bad">超级管理员</span>;
  if (role === 10) return <span className="admin_tag warn">管理员</span>;
  return <span className="admin_tag plain">玩家</span>;
}

/** 后台分页（与主站 Pager 同交互，样式走 admin_ 前缀） */
export function AdminPager({
  base,
  params,
  page,
  total,
  pageSize,
}: {
  base: string;
  params: Record<string, string | number | undefined>;
  page: number;
  total: number;
  pageSize: number;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) {
    return (
      <div className="admin_pager">
        共 {total.toLocaleString("zh-CN")} 条
      </div>
    );
  }
  const url = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    q.set("page", String(p));
    return `${base}?${q.toString()}`;
  };
  const links: (number | "...")[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= 2) {
      if (links[links.length - 1] !== p) links.push(p);
    } else if (links[links.length - 1] !== "...") links.push("...");
  }
  return (
    <div className="admin_pager">
      {page > 1 && (
        <Link href={url(page - 1)}>
          上一页
        </Link>
      )}
      {links.map((p, i) =>
        p === "..." ? (
          <span key={`e${i}`} style={{ border: 0 }}>
            …
          </span>
        ) : p === page ? (
          <span key={p} className="current">
            {p}
          </span>
        ) : (
          <Link key={p} href={url(p)}>
            {p}
          </Link>
        )
      )}
      {page < pageCount && (
        <Link href={url(page + 1)}>
          下一页
        </Link>
      )}
      <span style={{ border: 0, marginLeft: 14, color: "#75715e" }}>
        共 {total.toLocaleString("zh-CN")} 条 / {pageCount} 页
      </span>
    </div>
  );
}
