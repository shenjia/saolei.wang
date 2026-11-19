// 访客身份（2026-10-16 流量统计，参考 01xue.com src/lib/visitor.ts）
// 长期 cookie（1 年），用于 PV 去重 / UV 口径 / 会话切分。
// 命名 vid（visitor id），与登录 session cookie 区分；httpOnly，JS 不可读。

import { NextRequest, NextResponse } from "next/server";

export const VISITOR_COOKIE = "vid";

/** 读取访客 ID（没有则返回 null，不自动下发） */
export function getVisitorId(request: NextRequest): string | null {
  return request.cookies.get(VISITOR_COOKIE)?.value ?? null;
}

/** 确保访客 ID 存在：没有则生成并写 cookie 到响应 */
export async function ensureVisitorId(
  request: NextRequest,
  response: NextResponse
): Promise<{ visitorId: string; response: NextResponse }> {
  let vid = getVisitorId(request);
  if (!vid) {
    vid = crypto.randomUUID().replace(/-/g, "");
    response.cookies.set(VISITOR_COOKIE, vid, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return { visitorId: vid, response };
}

/** 提取客户端 IP（nginx 反代下取 X-Forwarded-For 首段） */
export function getClientIp(request: NextRequest): string {
  const xf = request.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim().slice(0, 39);
  return (request.headers.get("x-real-ip") ?? "unknown").slice(0, 39);
}
