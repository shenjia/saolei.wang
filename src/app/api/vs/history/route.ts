// 历史对决分页（2026-11-11 15:48 张老师：对决页历史板块改全站通用
// 「加载更多 + 页码滑条」翻页器，客户端追加/跳页走本 API）。
// 20:51 张老师定口径：＝**当前登录用户发起的**所有对决（与卡片上是谁无关）——
// 恒按 session.uid 查，不再信任客户端传的 l/r（原按卡上玩家查，两卡都不是
// 登录者时大概率空表）。
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVsHistory } from "@/lib/vs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const page = Math.max(1, parseInt(new URL(req.url).searchParams.get("page") ?? "1", 10) || 1);
  const hist = await getVsHistory(session.uid, session.uid, page, 10);
  return NextResponse.json(hist);
}
