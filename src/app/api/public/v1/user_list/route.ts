// 公开 API · 玩家公开信息批量查询（2026-10-24，由 partner/v1/users 更名迁移）
// GET /api/public/v1/user_list?id=1,2,3（最多 100 个）
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 轻量版：id/姓名/英文名/性别/地区/注册时间/封禁标记 + 8 列合计成绩。
// 要双体系分成绩、录像指针、标识列表请用 user_info（更全但更重）。
// QQ / 邮箱 / 注册 IP / 登录 IP / lastLogin 等隐私字段一律不出。
// 封禁用户（status!=0）返回 banned: true 且不给成绩，与站内「封禁不在榜」口径一致。

import { NextResponse } from "next/server";
import { requirePartner, unauthorized, rateLimited } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { areaDisplay } from "@/lib/config";

export async function GET(req: Request) {
  const partner = await requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`pub-user-list:${partner}`, 60, 60_000)) return rateLimited();

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
