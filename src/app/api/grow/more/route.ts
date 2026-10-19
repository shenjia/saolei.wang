// 进步榜「加载更多」增量接口（2026-09-24 张老师要求：进步榜改雷界排行同款表格）：
// GET /api/grow/more?page=N[&size=M] → { rows, total, pageSize }
// 行与 /grow SSR 同构（RankingRow + todayRank/yesterdayRank/delta + 军衔），客户端零成本渲染。
// size（2026-10-14 递增批量）：本批行数，skip 恒按 20/页锚点；不传=一页 20。

import { NextResponse } from "next/server";
import { getGrowRanking } from "@/lib/ranksnap";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingId } from "@/lib/title-system";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const sizeRaw = parseInt(p.get("size") ?? "", 10);
  const size = Math.min(Math.max(sizeRaw || 20, 20), 100);
  const { rows, total, pageSize } = await getGrowRanking(page, sizeRaw ? size : 20);
  // Phase 5：补旧版称号备选（进步榜行全部在榜）；2026-10-19 总司令=雷界第一人特判
  const king = await getThunderKingId();
  const pairs = await dualTitles(
    rows.map((u) => ({ userId: Number(u.id), expTime: u.scores.exp_time, ranked: true, sex: u.sex }))
  );
  const titled = await Promise.all(
    rows.map(async (u) => ({
      ...u,
      title: await assessTitle(u.scores.exp_time, king > 0 && king === Number(u.id)),
      classic: pairs.get(Number(u.id))?.c ?? null,
    }))
  );
  return NextResponse.json({ rows: titled, total, pageSize });
}
