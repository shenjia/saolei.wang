// 公开 API · 开源扫雷网绑定申请查询（2026-11-09 绑定协议 v2）
// GET /api/public/v1/openms/bind-request?token=<一次性令牌>
// 鉴权：无（协议定案「不做 API KEY」，凭 48 字符一次性 token 本身作为凭据）。
//
// 用途：开源扫雷网授权页（openms.top/bind/saolei?token=…）展示「谁在申请绑定」。
// 令牌由雷网用户在 /account/openms/bind 发起绑定后生成，仅返回最小信息。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPendingBindRequest } from "@/lib/openms";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const row = await getPendingBindRequest(token);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // 申请者雷网用户名（开源扫雷网授权页展示用）；老账号可能无 user_auth 行，回退中文名
  const [auth, urow] = await Promise.all([
    prisma.userAuth.findUnique({ where: { id: row.user }, select: { username: true } }),
    prisma.user.findUnique({ where: { id: row.user }, select: { chineseName: true } }),
  ]);
  return NextResponse.json({
    status: row.status, // 0=待确认 1=已核销 2=已取消（开源扫雷网授权页可据此展示）
    uid: Number(row.user),
    username: auth?.username ?? urow?.chineseName ?? "",
  });
}
