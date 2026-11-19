// 后台权限守卫（2026-09-24 管理后台）
// 三级权限：
//   PLAYER(0)        —— 无后台
//   MANAGER(10)      —— 可看仪表盘/分析、审核录像、管理内容（评论/论坛/动态）
//   ADMINISTRATOR(100) —— 额外可动玩家账号（封禁/改角色/改密码/删除）、群发、删除录像

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getSession, type SessionUser } from "@/lib/auth";
import { USER_ROLE, isManager } from "@/lib/config";

export type AdminLevel = "manager" | "administrator";

export function hasLevel(role: number, level: AdminLevel): boolean {
  return level === "administrator" ? role === USER_ROLE.ADMINISTRATOR : isManager(role);
}

export const LEVEL_NAMES: Record<AdminLevel, string> = {
  manager: "管理员",
  administrator: "超级管理员",
};

/** 页面守卫：未登录 → 登录页；权限不足 → 首页 */
export async function requireAdmin(level: AdminLevel = "manager"): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/account/login"); // 登录页暂不支持回跳参数，登录后从导航进后台
  if (!hasLevel(session.role, level)) redirect("/");
  return session;
}

/** 接口守卫：返回会话，或直接返回 401/403 响应 */
export async function requireAdminApi(
  level: AdminLevel = "manager"
): Promise<{ session: SessionUser } | { error: NextResponse }> {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
  if (!hasLevel(session.role, level)) {
    return { error: NextResponse.json({ error: "权限不足" }, { status: 403 }) };
  }
  return { session };
}

/** 取请求来源 IP（nginx 反代下取 X-Forwarded-For 首段） */
export async function clientIp(): Promise<string> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for") ?? "";
    const ip = fwd.split(",")[0]?.trim() || h.get("x-real-ip") || "";
    return ip.slice(0, 39);
  } catch {
    return "";
  }
}
