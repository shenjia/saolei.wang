// BV 收集榜「加载更多」增量接口（2026-10-13，对齐 /api/ranking/more 模式）：
// GET /api/ranking/bv/more?by=total|beg|int|exp&page=N → { rows, total, pageSize }
// 军衔在服务端预算随 JSON 返回，客户端直接渲染、零额外请求。

import { NextResponse } from "next/server";
import { getBvRanking } from "@/lib/queries";
import { parseBvRankingBy } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const by = parseBvRankingBy(p.get("by") ?? "");
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);

  const { rows, total, pageSize } = await getBvRanking(by, page);
  // 军衔 SUB 制按高级时间评定（与成绩榜同口径）
  const titled = rows.map((u) => ({ ...u, title: assessTitle(u.expTime) }));

  return NextResponse.json({ rows: titled, total, pageSize });
}
