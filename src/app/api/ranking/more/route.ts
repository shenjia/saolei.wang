// 排行榜「加载更多」增量接口（2026-09-24 张老师要求，替代分页）：
// GET /api/ranking/more?by=<排序列>&nf=1&page=N[&size=M][&area=地区名] → { rows, deltas }
// area（2026-10-15 地区内页换加载更多）：限定地区人口；带 area 时跳过日升降计算
// （地区内页不显示升降列，与 /area SSR 口径一致）
// 军衔与日升降在服务端预算好随 JSON 返回（对齐 /api/news/more 的模式），
// 客户端直接渲染、零额外请求。
// size（2026-10-14 递增批量）：本批行数，skip 恒按 20/页锚点；不传=一页 20。

import { NextResponse } from "next/server";
import { getRankingTable } from "@/lib/queries";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingId } from "@/lib/title-system";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const by = parseRankingBy(p.get("by") ?? "");
  const nf = p.get("view") === "nf" || p.get("nf") === "1";
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const sizeRaw = parseInt(p.get("size") ?? "", 10);
  const size = Math.min(Math.max(sizeRaw || 20, 20), 100);
  const area = p.get("area")?.trim() || undefined;

  const { rows, total, pageSize } = await getRankingTable(by, nf, page, area, sizeRaw ? size : undefined);

  let deltas: [number, number | null][] | undefined;
  if (by === "sum_time" && !nf && !area) {
    await ensureTodaySnapshot();
    const map = await getSumTimeDeltas(rows.map((r) => r.id));
    deltas = rows.map((r) => [r.id, map.get(r.id) ?? null] as [number, number | null]);
  }

  // 军衔 SUB 制按高级时间评定（2026-10-13）；NF 榜行数据来自 NF 表，exp_time 是 NF 口径，
  // 军衔应按主榜评定——与 RankingTable 同口径，优先主榜回填的 overallExpTime（2026-10-14 修复：NF 榜加载更多误评预备役）
  // 2026-10-19 总司令=雷界第一人特判（两体系共用 king 判定）
  const king = await getThunderKingId();
  const pairs = await dualTitles(rows.map((u) => ({ userId: Number(u.id), expTime: u.overallExpTime ?? u.scores.exp_time, ranked: true, sex: u.sex })));
  const titled = rows.map((u) => ({
    ...u,
    title: assessTitle(u.overallExpTime ?? u.scores.exp_time, king > 0 && king === Number(u.id)),
    classic: pairs.get(Number(u.id))?.c ?? null,
  }));

  return NextResponse.json({ rows: titled, deltas, total, pageSize });
}
