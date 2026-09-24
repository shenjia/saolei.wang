// 后台系统信息（2026-09-24）：数据库规模、环境依赖自检、运行状态
//
// 「自检」只报告不修改——把上线前必须配好的东西（SMTP / SITE_URL / 私信通道）摊开给管理员看。

import { prisma } from "@/lib/db";

export interface TableStat {
  table: string;
  label: string;
  rows: number;
}

const TABLES: [string, string][] = [
  ["user", "玩家"],
  ["user_auth", "账号"],
  ["user_scores", "最好成绩（标雷）"],
  ["user_scores_nf", "最好成绩（NF）"],
  ["video", "录像"],
  ["video_info", "录像解析信息"],
  ["video_stat", "录像统计"],
  ["video_scores_beg", "初级成绩流水"],
  ["video_scores_int", "中级成绩流水"],
  ["video_scores_exp", "高级成绩流水"],
  ["news", "成绩动态"],
  ["comment", "评论"],
  ["bbs_post", "论坛主题"],
  ["bbs_reply", "论坛回复"],
  ["message", "站内信"],
  ["click", "人气记录"],
  ["star", "每日一星"],
  ["history", "扫雷历程"],
  ["rank_snapshot", "排行快照"],
  ["admin_log", "后台操作日志"],
  ["donate", "赞助"],
  ["distribution", "军衔阈值"],
];

/** 各表行数（information_schema 一次取，比逐表 COUNT(*) 快得多） */
export async function getTableStats(): Promise<{ tables: TableStat[]; total: number }> {
  const rows = await prisma.$queryRawUnsafe<{ TABLE_NAME: string; TABLE_ROWS: bigint | null }[]>(
    `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  );
  const map = new Map(rows.map((r) => [r.TABLE_NAME, Number(r.TABLE_ROWS ?? 0)]));
  const tables = TABLES.map(([table, label]) => ({ table, label, rows: map.get(table) ?? 0 }));
  const total = tables.reduce((s, t) => s + t.rows, 0);
  return { tables, total };
}

export interface EnvCheck {
  key: string;
  label: string;
  ok: boolean;
  hint: string;
  /** 敏感值不回显明文，只报「已配置/未配置」 */
  secret?: boolean;
}

export function getEnvChecks(): EnvCheck[] {
  const has = (k: string) => Boolean(process.env[k]);
  return [
    {
      key: "DATABASE_URL",
      label: "数据库连接",
      ok: has("DATABASE_URL"),
      hint: "MySQL 连接串，缺失将无法启动",
      secret: true,
    },
    {
      key: "AUTH_SECRET",
      label: "会话签名密钥",
      ok: has("AUTH_SECRET"),
      hint: "HMAC 签名 JWT 用，缺失会导致无法登录",
      secret: true,
    },
    {
      key: "SMTP_HOST",
      label: "邮件服务器",
      ok: has("SMTP_HOST"),
      hint: "未配置时「找回密码」的邮件不会发出，重置链接只打服务端日志",
    },
    { key: "SMTP_PORT", label: "邮件端口", ok: has("SMTP_PORT"), hint: "通常 465（SSL）或 587（STARTTLS）" },
    { key: "SMTP_USER", label: "邮箱账号", ok: has("SMTP_USER"), hint: "发件邮箱登录名" },
    { key: "SMTP_PASS", label: "邮箱口令", ok: has("SMTP_PASS"), hint: "邮箱授权码", secret: true },
    { key: "SMTP_FROM", label: "发件人", ok: has("SMTP_FROM"), hint: "显示在邮件里的发件人" },
    { key: "SITE_URL", label: "站点地址", ok: has("SITE_URL"), hint: "用于拼重置密码链接，如 https://saolei.wang" },
  ];
}

export interface RuntimeInfo {
  nodeVersion: string;
  nextVersion: string;
  prismaVersion: string;
  env: string;
  uptimeSeconds: number;
  memoryMb: number;
  serverTime: number;
  timezone: string;
  dbVersion: string;
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT VERSION() v`);
  const mem = process.memoryUsage();
  return {
    nodeVersion: process.version,
    nextVersion: process.env.__NEXT_VERSION ?? "16.3.6",
    prismaVersion: "6.19.3",
    env: process.env.NODE_ENV ?? "development",
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(mem.rss / 1024 / 1024),
    serverTime: Math.floor(Date.now() / 1000),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dbVersion: rows[0]?.v ?? "?",
  };
}
