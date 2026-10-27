// 公开 API · 帖子关键词搜索（2026-10-27）
// GET /api/public/v1/post_search?keyword=xx&cursor=0
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 标题 LIKE %kw% 匹配（站内 /bbs 搜索同口径，不含正文/回复），固定 20 条/页，
// keyset cursor 翻页（id DESC：cursor=上次响应 nextCursor，取「id < cursor」的下一页）。
// 字段同 post_info（基本信息，不含正文）。只搜正常帖（status=0）。
// keyword 经 ?  参数化 +  %/_ 通配符转义，无注入面。

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requirePartner, unauthorized, rateLimited } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { usersByIds } from "@/lib/queries";
import { decodeLegacyEntities } from "@/lib/format";
import { likeContains } from "@/lib/sqlguard";

/** 每页条数（张老师定 20，固定不可调） */
const PAGE_SIZE = 20;

export async function GET(req: Request) {
  const partner = await requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`pub-post-search:${partner}`, 60, 60_000)) return rateLimited();

  const p = new URL(req.url).searchParams;

  // keyword 必填：去空白、限长 30（同站内 BBS 搜索截断口径）
  const keyword = (p.get("keyword") ?? "").trim().slice(0, 30);
  if (!keyword) {
    return NextResponse.json(
      { error: "bad_request", message: "需提供 keyword 参数（关键词，限 30 字）" },
      { status: 400 }
    );
  }

  const cursor = Math.max(0, parseInt(p.get("cursor") ?? "0", 10) || 0);

  // LIKE 转义：%/_ 恢复字面义（ESCAPE '\'），防通配符注入打宽结果集
  const like = likeContains(keyword);

  // keyset 翻页（id DESC）：cursor>0 时取 id < cursor 的下一页
  // 分页遍历量固定 ≤20，主键扫描无深翻页问题，不额外建索引
  const rows = await prisma.$queryRaw<{
    id: bigint; board: number; user: bigint; title: string;
    replies: number; clicks: number;
    is_pinned: number; is_nice: number; is_locked: number;
    last_reply_time: bigint; create_time: bigint; update_time: bigint;
  }[]>`
    SELECT id, board, user, title, replies, clicks,
           is_pinned, is_nice, is_locked, last_reply_time, create_time, update_time
    FROM bbs_post
    WHERE status = 0 AND title LIKE ${like}
    ${cursor > 0 ? Prisma.sql`AND id < ${cursor}` : Prisma.empty}
    ORDER BY id DESC
    LIMIT ${PAGE_SIZE}`;

  const authors = await usersByIds([...new Set(rows.map((r) => Number(r.user)))]);
  const hasMore = rows.length === PAGE_SIZE;

  return NextResponse.json({
    cursor,
    nextCursor: hasMore ? Number(rows[rows.length - 1].id) : null,
    hasMore,
    keyword,
    size: PAGE_SIZE,
    generatedAt: Math.floor(Date.now() / 1000),
    items: rows.map((r) => {
      const brief = authors.get(Number(r.user));
      return {
        id: Number(r.id),
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
