// 后台待审计数（2026-10-27，解决侧栏 badge 与页面数字不一致）
//
// 背景：badge 原先只在 admin/layout.tsx（服务端）算一次。App Router 在后台内点链接切换页面时
// 共享 layout 不重新执行，外壳沿用进后台那一刻的旧值——待审从 2 变 17，页面显示 17、badge 还是 2。
// 现在 layout 仍传首屏初值，客户端由 components/admin/PendingCounts.tsx 定期 / 切页 / 回到标签页时
// 拉本接口校准，侧栏与顶栏摘要共用同一份数据。
//
// 口径与 layout 完全一致：录像 status=10 / 头像 status=10 / 论坛 status=5（主题+回复）/ 反作弊未处理。
// 2026-11-10 补 exempt/need 分池字段（getPoolCounts 同口径）：首页 ReviewEntry 轮询复用本接口，
// 管理员停在首页时每分钟自动校准待审双池计数（有新待审自动出现、清零自动消失，不必手动刷新）。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin/guard";
import { getPoolCounts } from "@/lib/admin/data";
import { CONTENT_STATUS, VIDEO_STATUS } from "@/lib/config";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdminApi();
  if ("error" in guard) return guard.error;

  const [pending, avatar, bbsPost, bbsReply, cheat, pool] = await Promise.all([
    prisma.video.count({ where: { status: VIDEO_STATUS.NORMAL } }),
    prisma.avatarReview.count({ where: { status: AVATAR_REVIEW_STATUS.PENDING } }),
    prisma.bbsPost.count({ where: { status: CONTENT_STATUS.PENDING } }),
    prisma.bbsReply.count({ where: { status: CONTENT_STATUS.PENDING } }),
    prisma.cheatReport.count({ where: { resolved: 0 } }),
    getPoolCounts(),
  ]);

  // 后台计数仅供人工查看，禁止任何中间层缓存（nginx 侧也不该缓存 /admin 与 /api/admin）
  return NextResponse.json(
    { pending, avatar, bbs: bbsPost + bbsReply, cheat, exempt: pool.exempt, need: pool.need },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
