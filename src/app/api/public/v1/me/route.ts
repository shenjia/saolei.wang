// 公开 API · 用户登录态自检（2026-11-09）
// GET /api/public/v1/me
// 鉴权：Authorization: Bearer <token>（lib/usertoken.ts，login 签发的 7 天 token）。
// 供客户端验证 token 有效性并取回当前身份；后续用户侧 API 均按此方式鉴权。

import { NextResponse } from "next/server";
import { requireUserToken } from "@/lib/usertoken";

export async function GET(req: Request) {
  const ident = await requireUserToken(req);
  if (!ident) {
    return NextResponse.json(
      { error: "unauthorized", message: "缺少、无效或已过期的 Bearer token，请重新登录获取" },
      { status: 401 }
    );
  }
  return NextResponse.json({
    user: { id: ident.uid, username: ident.username, role: ident.role },
  });
}
