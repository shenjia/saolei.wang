// 排行榜「加载更多」增量接口（2026-09-24 张老师要求，替代分页）：
// GET /api/ranking/more?by=<排序列>&view=nf&page=N → { rows, deltas }
// 军衔与日升降在服务端预算好随 JSON 返回（对齐 /api/news/more 的模式），
// 客户端直接渲染、零额外请求。

import { NextResponse } from "next/server";
import { getRankingTable } from "@/lib/queries";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const by = parseRankingBy(p.get("by") ?? "");
  const nf = p.get("view") === "nf";
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);

  const { rows, total, pageSize } = await getRankingTable(by, nf, page);

  let deltas: [number, number | null][] | undefined;
  if (by === "sum_time" && !nf) {
    await ensureTodaySnapshot();
    const map = await getSumTimeDeltas(rows.map((r) => r.id));
    deltas = rows.map((r) => [r.id, map.get(r.id) ?? null] as [number, number | null]);
  }

  const titled = await Promise.all(
    rows.map(async (u) => ({ ...u, title: await assessTitle(u.overallSumTime ?? u.scores.sum_time) }))
  );

  return NextResponse.json({ rows: titled, deltas, total, pageSize });
}
