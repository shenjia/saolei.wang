// 随机串门（移植 2008 版 Player/Random.asp）：随机跳转一个有成绩用户的地盘
import { NextResponse } from "next/server";
import { getRandomUserId } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await getRandomUserId();
  // 相对 Location：req.url 在 nginx 反代下是内部地址（localhost:3100），
  // 用 new URL(path, req.url) 会把内网 host 泄给浏览器
  return new NextResponse(null, {
    status: 302,
    headers: { Location: id ? `/user/${id}` : "/ranking" },
  });
}
