// 比赛列表数据 API（2026-11-13 三轮：列表页翻页换通用「加载更多+滑轨」翻页器，
// 客户端壳 CompListFeed 经此接口取数）。口径与 /competitions 服务端渲染完全同源
// （getCompetitionPage：状态排序 → 切页；uid 带 joined 标记）。
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCompetitionPage } from "@/lib/competition";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const page = Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const size = Math.max(parseInt(url.searchParams.get("size") ?? "", 10) || 0, 1);
  const session = await getSession();
  const data = await getCompetitionPage(page, session?.uid, size);
  return NextResponse.json(data);
}
