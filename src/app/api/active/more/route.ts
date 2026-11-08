// 活跃排行「加载更多」增量接口（2026-11-08 张老师需求，结构同 /api/grow/more）：
// GET /api/active/more?page=N[&size=M][&by=act|beg|int|exp|cmt] → { rows, total, pageSize }
// 行与 /active SSR 同构（ActiveRow + 军衔双体系），客户端零成本渲染。
// size（递增批量）：本批行数，skip 恒按 20/页锚点；不传=一页 20。

import { NextResponse } from "next/server";
import { getActiveRanking, ACTIVE_BYS, type ActiveBy } from "@/lib/activerank";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingThreshold } from "@/lib/title-system";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const sizeRaw = parseInt(p.get("size") ?? "", 10);
  const size = Math.min(Math.max(sizeRaw || 20, 20), 100);
  const byRaw = p.get("by") as ActiveBy | null;
  const by: ActiveBy = byRaw && ACTIVE_BYS.includes(byRaw) ? byRaw : "act";
  const { rows, total, pageSize } = await getActiveRanking(page, sizeRaw ? size : 20, by);
  // 军衔双体系（2026-11-06 总司令=动态阈值档；无高级成绩 expTime=0 → 无军衔档）
  const kingTh = await getThunderKingThreshold();
  const pairs = await dualTitles(
    rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex }))
  );
  const titled = await Promise.all(
    rows.map(async (u, i) => ({
      ...u,
      title: await assessTitle(u.expTime, kingTh),
      classic: pairs[i]?.c ?? null,
    }))
  );
  return NextResponse.json({ rows: titled, total, pageSize });
}
