// 合作站点全量榜单同步（2026-10-21，首批 openms.top）
// GET /api/partner/v1/rankings?by=<beg_time|beg_3bvs|int_time|int_3bvs|exp_time|exp_3bvs|sum_time|sum_3bvs>&view=nf&page=1
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 数据口径与站内 /ranking 完全一致（同一套 user_scores / user_scores_nf 表 + rankedOnly 封禁排除），
// 但只出口公开数据：玩家 id / 姓名 / 每列成绩 / 关联录像 id。不出口地区、QQ、邮箱、IP 等任何个人信息。
//
// 全量拉取姿势（给合作方）：按 by 循环 page=1..⌈total/100⌉（size 固定 100）。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePartner, unauthorized } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { SCORE_FIELD, VIDEO_FIELD, rankedOnly, usersByIds } from "@/lib/queries";
import { ORDER_DIRECTION, parseRankingBy, byLevelOrder } from "@/lib/config";

export async function GET(req: Request) {
  const partner = requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`partner-rankings:${partner}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited", message: "请求过频，请降低频率（限 60 次/分钟）" }, { status: 429 });
  }

  const p = new URL(req.url).searchParams;
  const by = parseRankingBy(p.get("by") ?? "");
  const nf = p.get("view") === "nf";
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const size = 100; // 固定批量，合作方全量同步用

  const { level, order } = byLevelOrder(by);
  const field = SCORE_FIELD(level, order);
  const vField = VIDEO_FIELD(level, order);

  // 复用 queries.ts 的统一委托类型做法（union delegate 不可调用）
  const table = nf ? prisma.userScoresNf : prisma.userScores;
  const where: Record<string, unknown> = { [field]: { gt: 0 }, ...(await rankedOnly()) };
  const [total, rows] = await Promise.all([
    table.count({ where }),
    table.findMany({
      where,
      orderBy: { [field]: ORDER_DIRECTION[order] },
      skip: (page - 1) * size,
      take: size,
      select: { id: true, [field]: true, [vField]: true },
    }),
  ]);

  const authors = await usersByIds(rows.map((r: { id: bigint }) => Number(r.id)));

  return NextResponse.json({
    by,
    view: nf ? "nf" : "standard",
    page,
    size,
    total,
    generatedAt: Math.floor(Date.now() / 1000),
    rows: rows.map((r: Record<string, bigint | number | null>, i: number) => {
      const brief = authors.get(Number(r.id)) ?? { id: Number(r.id), chineseName: "?", englishName: "", sex: 1 };
      return {
        rank: (page - 1) * size + i + 1,
        id: Number(r.id),
        name: brief.chineseName,
        englishName: brief.englishName,
        score: Number(r[field]),
        videoId: Number(r[vField] ?? 0),
      };
    }),
  });
}
