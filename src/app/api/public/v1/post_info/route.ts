// 公开 API · 帖子基本信息查询（2026-10-27）
// GET /api/public/v1/post_info?id=1,2,3（逗号分隔，最多 50 个）
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 字段对齐 post_search（标题/分类/发布者/发布时间/更新时间/评论数/点击数/
// 置顶/加精/锁定/最后回复），**不含正文**——正文请引导用户访问
// https://saolei.wang/bbs/{id}（正文含 UBB 富文本，API 不出）。
// 只出正常帖（status=0）；删除帖（-1）/待审帖（5，仅本人与管理员站内可见）不返回。
// updateTime 语义：最后一次编辑（主题更新/加精/置顶等写操作），非最后回复时间——
// 最后回复时间单列 lastReplyTime。

import { NextResponse } from "next/server";
import { requirePartner, unauthorized, rateLimited } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { usersByIds } from "@/lib/queries";
import { decodeLegacyEntities } from "@/lib/format";

// id → 基本信息字段集（post_info / post_search 共用形状，2026-10-27）
export async function GET(req: Request) {
  const partner = await requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`pub-post-info:${partner}`, 60, 60_000)) return rateLimited();

  const p = new URL(req.url).searchParams;
  const ids = (p.get("id") ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 50);
  if (!ids.length) {
    return NextResponse.json({ error: "bad_request", message: "需提供 id 参数（逗号分隔的帖子 ID，最多 50 个）" }, { status: 400 });
  }

  // 只取轻量列（不 SELECT content 大字段）；正常帖才返回
  const rows = await prisma.$queryRawUnsafe<{
    id: bigint; board: number; user: bigint; title: string;
    replies: number; clicks: number;
    is_pinned: number; is_nice: number; is_locked: number;
    last_reply_time: bigint; create_time: bigint; update_time: bigint;
  }[]>(
    `SELECT id, board, user, title, replies, clicks,
            is_pinned, is_nice, is_locked, last_reply_time, create_time, update_time
     FROM bbs_post
     WHERE status = 0 AND id IN (${ids.join(",")})
     ORDER BY id DESC`
  );

  const authors = await usersByIds([...new Set(rows.map((r) => Number(r.user)))]);

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    items: rows.map((r) => {
      const brief = authors.get(Number(r.user));
      return {
        id: Number(r.id),
        // 标题出口解码老 ASP 实体（&nbsp; 等，同站内列表口径）
        title: decodeLegacyEntities(r.title),
        board: r.board,
        userId: Number(r.user),
        userName: brief?.chineseName ?? "?",
        postTime: Number(r.create_time),
        updateTime: Number(r.update_time),
        lastReplyTime: Number(r.last_reply_time),
        replies: Number(r.replies),
        clicks: Number(r.clicks),
        pinned: Number(r.is_pinned) === 1,
        nice: Number(r.is_nice) === 1,
        locked: Number(r.is_locked) === 1,
      };
    }),
  });
}
