// 随机串门（移植 2008 版 Player/Random.asp）：随机跳转一个有成绩用户的地盘
import { NextResponse } from "next/server";
import { getRandomUserId } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = await getRandomUserId();
  return NextResponse.redirect(new URL(id ? `/user/${id}` : "/ranking", req.url));
}
