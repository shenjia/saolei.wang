// 公开 API · 录像元数据增量同步（2026-10-24，由 partner/v1/videos 更名迁移）
// GET /api/public/v1/video_list?cursor=<录像id>&since=<Unix秒>&level=<beg|int|exp>&player_id=<玩家id>&size=200
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 同步语义（增量）：
//  - 首次全量：不传 cursor，从 id=1 起按 id 升序拉完（循环到 hasMore=false）
//  - 增量：上次响应的 nextCursor 继续拉；也可用 since=<上传时间秒> 跳到近段
//    （since 与 cursor 同时给时以 cursor 为准）
//  - 返回全部审核状态（0=屏蔽 / 10=待审 / 20=通过），可用 player_id 限定玩家
//  - 文件本体不给（合作方需要回放请引导用户来本站；这也正是数据同步的商业意义）
//
// 3bvs 字段已按站内口径（ROUND(board_3bv×1e6/real_time)，运气盘记负值）算好直接给，
// 消费方无需自行换算。

import { NextResponse } from "next/server";
import { requirePartner, unauthorized, rateLimited } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { MIN_3BV_FOR_3BVS, VIDEO_LEVELS, assertVideoLevel, type VideoLevel } from "@/lib/config";
import { prisma } from "@/lib/db";
import { usersByIds } from "@/lib/queries";

export async function GET(req: Request) {
  const partner = await requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`pub-video-list:${partner}`, 60, 60_000)) return rateLimited();

  const p = new URL(req.url).searchParams;
  const cursor = Math.max(0, parseInt(p.get("cursor") ?? "0", 10) || 0);
  const since = Math.max(0, parseInt(p.get("since") ?? "0", 10) || 0);
  const lv = p.get("level") ?? "";
  const level = (VIDEO_LEVELS as readonly string[]).includes(lv) ? (lv as VideoLevel) : undefined;
  const size = Math.min(Math.max(parseInt(p.get("size") ?? "200", 10) || 200, 1), 1000);
  const playerIdRaw = p.get("player_id");
  const playerId = playerIdRaw === null ? null : Number(playerIdRaw);
  if (playerIdRaw !== null && (!/^\d+$/.test(playerIdRaw) || !Number.isSafeInteger(playerId) || playerId === null || playerId < 1)) {
    return NextResponse.json(
      { error: "bad_request", message: "player_id 需为大于 0 的整数" },
      { status: 400 }
    );
  }

  // create_time 为 Unix 秒；cursor 优先，since 作为无 cursor 时的起点过滤
  const conds: string[] = [];
  if (cursor > 0) conds.push(`v.id > ${cursor}`);
  if (cursor === 0 && since > 0) conds.push(`v.create_time >= ${since}`);
  // 2026-10-27 SQL 注入加固：虽然上面已白名单归一，拼接前仍过 assertVideoLevel 运行时断言
  if (level) conds.push(`v.level = '${assertVideoLevel(level)}'`);
  if (playerId !== null) conds.push(`v.user = ${playerId}`);

  const rows = await prisma.$queryRawUnsafe<{
    id: bigint; level: string; user: bigint; hash: string; status: number;
    create_time: bigint; review_time: bigint | null;
    real_time: number; board_3bv: number; noflag: number;
    software: string; version: string;
  }[]>(
    `SELECT v.id, v.level, v.user, v.hash, v.status, v.create_time, v.review_time,
            vi.real_time, vi.board_3bv, vi.noflag, vi.software, vi.version
     FROM video v JOIN video_info vi ON vi.id = v.id
     ${conds.length ? `WHERE ${conds.filter(Boolean).join(" AND ")}` : ""}
     ORDER BY v.id ASC LIMIT ${size}`
  );

  const authors = await usersByIds(rows.map((r) => Number(r.user)));

  const items = rows.map((r) => {
    const brief = authors.get(Number(r.user));
    const bv = Number(r.board_3bv);
    const rt = Number(r.real_time);
    const sign = rt > 0 && bv >= MIN_3BV_FOR_3BVS[r.level as VideoLevel] ? 1 : -1;
    return {
      id: Number(r.id),
      level: r.level,
      userId: Number(r.user),
      userName: brief?.chineseName ?? "?",
      hash: r.hash,
      status: Number(r.status),
      uploadTime: Number(r.create_time),
      reviewTime: r.review_time ? Number(r.review_time) : 0,
      realTime: rt,
      board3bv: bv,
      "3bvs": rt > 0 ? sign * Math.round((bv * 1000000) / rt) : 0,
      nf: Number(r.noflag) === 1,
      software: r.software,
      version: r.version,
    };
  });

  const hasMore = rows.length === size;

  return NextResponse.json({
    cursor,
    nextCursor: hasMore ? Number(rows[rows.length - 1].id) : null,
    hasMore,
    size,
    generatedAt: Math.floor(Date.now() / 1000),
    items,
  });
}
