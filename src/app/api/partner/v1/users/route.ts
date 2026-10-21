// 合作站点玩家公开信息批量查询（2026-10-21，首批 openms.top）
// GET /api/partner/v1/users?id=1,2,3（最多 100 个）
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 只出口排行榜/录像页上本来就公开的字段 + 8 列成绩。
// QQ / 邮箱 / 注册 IP / 登录 IP / lastLogin 等隐私字段一律不出。
// 封禁用户（status!=0）返回 banned: true 且不给成绩，与站内「封禁不在榜」口径一致。

import { NextResponse } from "next/server";
import { requirePartner, unauthorized } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { areaDisplay } from "@/lib/config";

export async function GET(req: Request) {
  const partner = requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`partner-users:${partner}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited", message: "请求过频，请降低频率（限 60 次/分钟）" }, { status: 429 });
  }

  const p = new URL(req.url).searchParams;
  const ids = (p.get("id") ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 100);
  if (!ids.length) {
    return NextResponse.json({ error: "bad_request", message: "需提供 id 参数（逗号分隔的玩家 ID，最多 100 个）" }, { status: 400 });
  }

  const [users, scores] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids.map(BigInt) } } }),
    prisma.userScores.findMany({ where: { id: { in: ids.map(BigInt) } } }),
  ]);
  const scoreMap = new Map(scores.map((s) => [Number(s.id), s]));

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    users: users.map((u) => {
      const s = scoreMap.get(Number(u.id));
      const banned = u.status !== 0;
      return {
        id: Number(u.id),
        name: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        area: areaDisplay(u.area),
        registeredAt: Number(u.createTime),
        banned,
        ...(banned ? {} : {
          scores: s ? {
            begTime: Number(s.begTime), beg3bvs: Number(s.beg3bvs),
            intTime: Number(s.intTime), int3bvs: Number(s.int3bvs),
            expTime: Number(s.expTime), exp3bvs: Number(s.exp3bvs),
            sumTime: Number(s.sumTime), sum3bvs: Number(s.sum3bvs),
          } : null,
        }),
      };
    }),
  });
}
