// 旧路由 /world/[军衔] → /titles/[军衔]（雷界→军衔页改名遗留，2026-09-24）

import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ title: string }> }
) {
  const { title } = await params;
  // params 已解码为中文，Location 须重新编码（ByteString 限制）；
  // 用相对 Location（nginx 反代下绝对 URL 会泄内部 host，见项目记忆 route handler 重定向坑）
  return new NextResponse(null, {
    status: 301,
    headers: { Location: `/titles/${encodeURIComponent(title)}` },
  });
}
