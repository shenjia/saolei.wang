// 进步榜「加载更多」增量接口（2026-09-24 张老师要求：进步榜改雷界排行同款表格）：
// GET /api/grow/more?page=N → { rows, total, pageSize }
// 行与 /grow SSR 同构（RankingRow + todayRank/yesterdayRank/delta + 军衔），客户端零成本渲染。

import { NextResponse } from "next/server";
import { getGrowRanking } from "@/lib/ranksnap";
import { title as assessTitle } from "@/lib/assess";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getGrowRanking(page);
  const titled = await Promise.all(
    rows.map(async (u) => ({ ...u, title: await assessTitle(u.scores.sum_time) }))
  );
  return NextResponse.json({ rows: titled, total, pageSize });
}
