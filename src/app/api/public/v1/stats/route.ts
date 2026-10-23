// 公开 API · 站点基础统计（2026-10-24）
// GET /api/public/v1/stats
// 鉴权：X-Api-Key（lib/partner.ts），限速 60 次/分/合作方。
//
// 与首页「站点统计」版块同口径（getSiteStats，unstable_cache 60s 复用），
// 外加 maxVideoId / maxUserId（openms 机器人确定抓取范围用——2026-10-24 需求表）。
// today 增量字段不外发（对第三方意义有限，且口径解释成本高）。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePartner, unauthorized, rateLimited } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { getSiteStats } from "@/lib/queries";
import { unstable_cache } from "next/cache";

/** max id 两个（60s 缓存，与 site-stats 同节律；MAX(id) 主键反扫，快） */
const fetchMaxIds = unstable_cache(
  async () => {
    const [v, u] = await Promise.all([
      prisma.video.aggregate({ _max: { id: true } }),
      prisma.user.aggregate({ _max: { id: true } }),
    ]);
    return { maxVideoId: Number(v._max.id ?? 0), maxUserId: Number(u._max.id ?? 0) };
  },
  ["public-api-max-ids-v1"],
  { revalidate: 60 }
);

export async function GET(req: Request) {
  const partner = await requirePartner(req);
  if (!partner) return unauthorized();
  if (!rateLimit(`pub-stats:${partner}`, 60, 60_000)) return rateLimited();

  const [stats, maxIds] = await Promise.all([getSiteStats(), fetchMaxIds()]);

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    stats: {
      // 注册人数（旧站口径：排除封禁）
      userTotal: stats.userTotal,
      // 排行人数（sum_time>0 且未封禁）
      rankedTotal: stats.rankedTotal,
      // 录像数（status<>0：待审+已通过，2026-10-23 张老师定的前台口径）
      videoTotal: stats.videoTotal,
      // 录像评论数
      videoCommentTotal: stats.commentTotal,
      // 论坛主题数 / 论坛回复数
      bbsTopicTotal: stats.bbsTotal,
      bbsReplyTotal: stats.bbsReplyTotal,
      // 在线练习累计盘数
      practiceTotal: stats.practiceTotal,
    },
    // 供增量抓取定位（openms 机器人需求：确定抓取范围，减少全量试探请求）
    maxVideoId: maxIds.maxVideoId,
    maxUserId: maxIds.maxUserId,
  });
}
