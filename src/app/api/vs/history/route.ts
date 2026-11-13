// 历史对决分页（2026-11-11 15:48 张老师：对决页历史板块改全站通用
// 「加载更多 + 页码滑条」翻页器，客户端追加/跳页走本 API）。
// 2026-11-13 张老师定口径：＝**登录者发起的**所有对决（发起者＝访问者，不
// 一定是参赛双方——指定 A、B 两人 PK 的旁观对决也算）——恒按 session.uid 查，
// 不再信任客户端传的 l/r（本就忽略）。
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVsHistory } from "@/lib/vs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const page = Math.max(1, parseInt(new URL(req.url).searchParams.get("page") ?? "1", 10) || 1);
  const hist = await getVsHistory(session.uid, page, 10);
  return NextResponse.json(hist);
}
