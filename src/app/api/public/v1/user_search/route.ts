// 公开 API · 玩家搜索（2026-11-09 张老师需求）
// GET /api/public/v1/user_search?keyword=昵称[&limit=10]
// 鉴权：X-Api-Key（lib/partner.ts），限速按 key 各自配置。
//
// 与站内排行搜索框同口径（lib/queries searchUsers）：
//   · 中文姓名 前缀 / 包含 模糊 + 英文名 前缀；纯数字 = id 精确匹配
//   · 排序＝上榜者按全国总计时间榜名次序在前，未上榜沉底按 id 升序
//   · 封禁账号（status≠0）不出——与榜单「封禁不在榜」口径一致
// 返回 { users: [{ id, name, englishName, area, avatar, title }] }：
//   · avatar = 头像完整 URL（新版上传 / OAuth 外链 / 旧站照片；无头像 = 空串）
//   · title  = 军衔制称号（总司令=动态阈值档，与站内榜单徽章同口径）
// 隐私不出：QQ / 邮箱 / IP / 登录时间等一律不返回。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePartnerEx, unauthorized, rateLimited, partnerRateLimit } from "@/lib/partner";
import { escapeLike } from "@/lib/sqlguard";
import { areaDisplay } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { getThunderKingThreshold } from "@/lib/title-system";

/** 头像完整 URL：/uploads 上传与 http 外链原样（补域名），旧站标记位 "1" → /images/player/{id}.jpg，其余 = 无头像 */
function avatarUrl(base: string, id: number, avatar: string): string {
  if (avatar.startsWith("/uploads/")) return `${base}${avatar}`;
  if (avatar.startsWith("http")) return avatar;
  if (avatar === "1") return `${base}/images/player/${id}.jpg`;
  return "";
}

export async function GET(req: Request) {
  const partner = await requirePartnerEx(req);
  if (!partner) return unauthorized();
  if (!partnerRateLimit(partner, "pub-user-search")) return rateLimited(partner.ratePerMin);

  const p = new URL(req.url).searchParams;
  const kw = (p.get("keyword") ?? p.get("q") ?? "").trim().slice(0, 12);
  if (!kw) {
    return NextResponse.json({ error: "bad_request", message: "需提供 keyword 参数（限 12 字）" }, { status: 400 });
  }
  const take = Math.min(20, Math.max(1, parseInt(p.get("limit") ?? "10", 10) || 10));

  // 站内 searchUsers 同款查询，多取 area/avatar/exp_time（称号与地区展示用）；
  // LIMIT 为 clamp 后的整数直插（无注入面），关键词走 ? 占位符 + escapeLike。
  const rows = await prisma.$queryRawUnsafe<
    {
      id: bigint;
      chinese_name: string;
      english_name: string;
      sex: number;
      area: string;
      avatar: string;
      exp_time: number | null;
    }[] >(
    `SELECT u.id, u.chinese_name, u.english_name, u.sex, u.area, u.avatar, us.exp_time
     FROM user u
     LEFT JOIN user_scores us ON us.id = u.id
     WHERE u.status = 0
       AND (u.chinese_name LIKE ? OR u.chinese_name LIKE ? OR u.english_name LIKE ?)
     ORDER BY CASE WHEN us.sum_time IS NULL OR us.sum_time <= 0 THEN 1 ELSE 0 END,
              us.sum_time ASC, u.id ASC
     LIMIT ${take}`,
    `${escapeLike(kw)}%`,
    `%${escapeLike(kw)}%`,
    `${escapeLike(kw)}%`
  );

  // 军衔称号：总司令=动态阈值档（与榜单徽章同口径）
  const kingTh = await getThunderKingThreshold();
  const base = process.env.SITE_URL ?? new URL(req.url).origin;

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    keyword: kw,
    size: rows.length,
    users: rows.map((r) => ({
      id: Number(r.id),
      name: r.chinese_name,
      englishName: r.english_name,
      area: areaDisplay(r.area),
      avatar: avatarUrl(base, Number(r.id), r.avatar),
      title: assessTitle(Number(r.exp_time), kingTh),
    })),
  });
}
