// 公开 API · 录像详情（2026-10-24）
// GET /api/public/v1/video_info?id=1,2,3（逗号分隔，最多 50 个）
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 返回录像全部**已落盘公开字段**（video + video_info + video_metrics 落盘部分），
// 含 userId / userName（原 partner 草案 videos 接口不含逐盘指标，本接口补齐）。
// 只出口站内公开展示口径：屏蔽(0)录像 404 不返回；待审(10)/已通过(20)可查
// （status 字段如实返回，2026-10-23 张老师定的前台口径：待审即上传即可见）。
// 隐私不出：文件路径 filepath、审核人 reviewUser 等。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePartner, unauthorized, rateLimited } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { usersByIds } from "@/lib/queries";
import { MIN_3BV_FOR_3BVS, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";

export async function GET(req: Request) {
  const partner = await requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`pub-video-info:${partner}`, 60, 60_000)) return rateLimited();

  const p = new URL(req.url).searchParams;
  const ids = (p.get("id") ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 50);
  if (!ids.length) {
    return NextResponse.json({ error: "bad_request", message: "需提供 id 参数（逗号分隔的录像 ID，最多 50 个）" }, { status: 400 });
  }

  // video + video_info + video_metrics 三表 LEFT JOIN：metrics 缺行（未跑批/重放失败）给 null
  const rows = await prisma.$queryRawUnsafe<
    {
      id: bigint; level: string; user: bigint; hash: string; status: number;
      create_time: bigint; review_time: bigint | null;
      real_time: number; board_3bv: number; noflag: number;
      software: string; version: string; signature: string;
      cl: number | null; cl_left: number | null; cl_right: number | null;
      cl_double: number | null; ce: number | null; path: number | null;
      ioe: number | null; stnb: number | null;
    }[]
  >(
    `SELECT v.id, v.level, v.user, v.hash, v.status, v.create_time, v.review_time,
            vi.real_time, vi.board_3bv, vi.noflag, vi.software, vi.version, vi.signature,
            m.cl, m.cl_left, m.cl_right, m.cl_double, m.ce, m.path, m.ioe, m.stnb
     FROM video v
     JOIN video_info vi ON vi.id = v.id
     LEFT JOIN video_metrics m ON m.id = v.id
     WHERE v.id IN (${ids.join(",")}) AND v.status <> 0`
  );

  const authors = await usersByIds([...new Set(rows.map((r) => Number(r.user)))]);

  const items = rows.map((r) => {
    const brief = authors.get(Number(r.user));
    const bv = Number(r.board_3bv);
    const rt = Number(r.real_time);
    const sign = rt > 0 && bv >= MIN_3BV_FOR_3BVS[r.level as VideoLevel] ? 1 : -1;
    return {
      id: Number(r.id),
      level: (VIDEO_LEVELS as readonly string[]).includes(r.level) ? r.level : r.level,
      userId: Number(r.user),
      userName: brief?.chineseName ?? "?",
      hash: r.hash,
      status: Number(r.status), // 10=待审 20=已通过（屏蔽 0 不返回）
      uploadTime: Number(r.create_time),
      reviewTime: r.review_time ? Number(r.review_time) : 0,
      realTime: rt,
      board3bv: bv,
      "3bvs": rt > 0 ? sign * Math.round((bv * 1000000) / rt) : 0,
      nf: Number(r.noflag) === 1,
      software: r.software,
      version: r.version,
      // 玩家标识（录像内嵌签名，站内「录像标识」版块口径）
      signature: r.signature,
      // 重放指标（video_metrics 落盘部分；缺行=null）
      metrics: r.cl === null ? null : {
        cl: Number(r.cl),
        clLeft: Number(r.cl_left),
        clRight: Number(r.cl_right),
        clDouble: Number(r.cl_double),
        ce: Number(r.ce),
        path: Number(r.path),
        ioe: Number(r.ioe),
        stnb: Number(r.stnb),
      },
    };
  });

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    items,
  });
}
