// 比赛动态分页 API（GET /api/tournament/[id]/events?page=1&size=20）
// 2026-11-13 五轮：详情页动态板块换 PageSlider，client 壳「加载更多」走本接口
// （前缀整批替换语义：page=1&size=N 取最新 N 条，与 TourListFeed 同口径）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getTourEventsPage, parseTourEventsFilter } from "@/lib/tournament";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const compId = parseInt(id, 10);
  if (!Number.isInteger(compId) || compId <= 0) {
    return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 });
  }

  const sp = new URL(req.url).searchParams;
  const page = Math.max(parseInt(sp.get("page") ?? "1", 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(sp.get("size") ?? "20", 10) || 20, 1), 100);
  // 动态筛选（2026-11-23）：服务端按 filter + session 取数，不信客户端传 uid（防越权）。
  const filter = parseTourEventsFilter(sp.get("ef"));
  const session = filter === "follow" ? await getSession() : null;

  const data = await getTourEventsPage(compId, page, size, {
    filter,
    viewerId: session?.uid,
  });
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return NextResponse.json({ ok: true, ...data, totalPages });
}
