// 旧路由 /world（雷界→军衔页改名遗留），301 到 /titles（2026-09-24）
// 相对 Location（nginx 反代下绝对 URL 会泄内部 host，见项目记忆 route handler 重定向坑）

import { NextResponse } from "next/server";

export function GET() {
  return new NextResponse(null, {
    status: 301,
    headers: { Location: "/titles" },
  });
}
