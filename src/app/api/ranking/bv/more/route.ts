// BV 收集榜「加载更多」增量接口（2026-10-13，对齐 /api/ranking/more 模式）：
// GET /api/ranking/bv/more?by=total|beg|int|exp&page=N[&size=M][&nf=1] → { rows, total, pageSize }
// 军衔在服务端预算随 JSON 返回，客户端直接渲染、零额外请求。
// size（2026-10-14 递增批量）：本批行数，skip 恒按 20/页锚点；不传=一页 20。

import { NextResponse } from "next/server";
import { getBvRanking } from "@/lib/queries";
import { parseBvRankingBy } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingId } from "@/lib/title-system";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const by = parseBvRankingBy(p.get("by") ?? "");
  const nf = p.get("nf") === "1";
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const sizeRaw = parseInt(p.get("size") ?? "", 10);
  const size = Math.min(Math.max(sizeRaw || 20, 20), 100);

  // 降级（2026-10-14）：BV 全量聚合失败时（冷缓存重建 + DB 抖动）返回 503 而非 500，
  // 客户端对 !res.ok 已有处理（BvRankingFeed 显示「加载失败，请重试」）
  let data;
  try {
    data = await getBvRanking(by, page, sizeRaw ? size : undefined, nf);
  } catch (e) {
    console.error("[api/ranking/bv/more] BV 榜数据获取失败", e);
    return NextResponse.json({ error: "bv_unavailable" }, { status: 503 });
  }
  const { rows, total, pageSize } = data;
  // 军衔 SUB 制按高级时间评定（与成绩榜同口径）；2026-10-19 总司令=雷界第一人特判
  const king = await getThunderKingId();
  const pairs = await dualTitles(rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex })));
  const titled = rows.map((u, i) => ({
    ...u,
    title: assessTitle(u.expTime, king > 0 && king === u.id),
    classic: pairs[i]?.c ?? null,
  }));

  return NextResponse.json({ rows: titled, total, pageSize });
}
