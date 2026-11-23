// 公开 API · 玩家详情（2026-10-24）
// GET /api/public/v1/user_info?id=1,2,3（逗号分隔，最多 50 个）
// 鉴权：X-Api-Key（lib/partner.ts），限速按 key 各自配置（默认 60 次/分，0=不限）。
//
// 返回玩家公开信息 + 双体系成绩（标准/NF 各级 time/3bvs 附达成录像 ID）
// + 录像标识列表（user_sig，站内「录像标识」版块口径，本站特有数据）。
// QQ / 邮箱 / 注册 IP / 登录 IP 等隐私字段一律不出。
// 封禁用户（status!=0）返回 banned: true 且不给成绩，与站内「封禁不在榜」口径一致。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePartnerEx, unauthorized, rateLimited, partnerRateLimit } from "@/lib/partner";
import { areaDisplay } from "@/lib/config";
import { resolveAvatarUrl, DEFAULT_AVATAR } from "@/lib/avatar";

export async function GET(req: Request) {
  const partner = await requirePartnerEx(req);
  if (!partner) return unauthorized();
  if (!partnerRateLimit(partner, "pub-user-info")) return rateLimited(partner.ratePerMin);

  const p = new URL(req.url).searchParams;
  const ids = (p.get("id") ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 50);
  if (!ids.length) {
    return NextResponse.json({ error: "bad_request", message: "需提供 id 参数（逗号分隔的玩家 ID，最多 50 个）" }, { status: 400 });
  }

  const bigIds = ids.map(BigInt);
  const [users, scores, scoresNf, sigs] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: bigIds } } }),
    prisma.userScores.findMany({ where: { id: { in: bigIds } } }),
    prisma.userScoresNf.findMany({ where: { id: { in: bigIds } } }),
    prisma.userSig.findMany({ where: { user: { in: bigIds } }, orderBy: { id: "asc" } }),
  ]);
  const scoreMap = new Map(scores.map((s) => [Number(s.id), s]));
  const scoreNfMap = new Map(scoresNf.map((s) => [Number(s.id), s]));
  const sigMap = new Map<number, string[]>();
  for (const s of sigs) {
    const uid = Number(s.user);
    if (!sigMap.has(uid)) sigMap.set(uid, []);
    sigMap.get(uid)!.push(s.signature);
  }

  /** user_scores(_nf) 行 → 双体系成绩对象（各级 time/3bvs 附录像指针，0=无） */
  const scoresOf = (
    s: typeof scores[number] | undefined
  ) =>
    s
      ? {
          beg: { time: Number(s.begTime ?? 0), timeVideoId: Number(s.begTimeVideo ?? 0), "3bvs": Number(s.beg3bvs ?? 0), "3bvsVideoId": Number(s.beg3bvsVideo ?? 0) },
          int: { time: Number(s.intTime ?? 0), timeVideoId: Number(s.intTimeVideo ?? 0), "3bvs": Number(s.int3bvs ?? 0), "3bvsVideoId": Number(s.int3bvsVideo ?? 0) },
          exp: { time: Number(s.expTime ?? 0), timeVideoId: Number(s.expTimeVideo ?? 0), "3bvs": Number(s.exp3bvs ?? 0), "3bvsVideoId": Number(s.exp3bvsVideo ?? 0) },
          sum: { time: Number(s.sumTime ?? 0), "3bvs": Number(s.sum3bvs ?? 0) },
        }
      : null;

  // 头像完整 URL：与 me 接口同款解析（新版上传 /uploads/avatar/… 与 OAuth 外链
  // 原样；旧站标记位 "1" → 照片墙 /images/player/{id}.jpg；其余统一默认图 no.jpg）。
  // 相对路径拼完整域名（SITE_URL 优先，未配退请求 origin），调用方拿到即可直接展示。
  const base = process.env.SITE_URL ?? new URL(req.url).origin;

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    users: users.map((u) => {
      const banned = u.status !== 0;
      const rawAvatar = resolveAvatarUrl(
        u.avatar,
        u.avatar === "1" ? `/images/player/${Number(u.id)}.jpg` : DEFAULT_AVATAR
      );
      return {
        id: Number(u.id),
        name: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        area: areaDisplay(u.area),
        avatarUrl: /^https?:\/\//.test(rawAvatar) ? rawAvatar : `${base}${rawAvatar}`,
        registeredAt: Number(u.createTime),
        banned,
        ...(banned
          ? {}
          : {
              scores: scoresOf(scoreMap.get(Number(u.id))),
              scoresNf: scoresOf(scoreNfMap.get(Number(u.id))),
              // 录像标识列表（站内特有：玩家自注册的录像签名归属）
              signatures: sigMap.get(Number(u.id)) ?? [],
            }),
      };
    }),
  });
}
