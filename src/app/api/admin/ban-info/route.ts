// 封禁弹窗信息接口（2026-10-16 限时封禁）
// 返回某玩家「可连坐封禁」的录像数（待审 10 + 已通过 20），供封禁弹窗打开时展示。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireAdminApi("administrator");
  if ("error" in guard) return guard.error;

  const userId = parseInt(new URL(req.url).searchParams.get("userId") ?? "", 10);
  if (!userId) return NextResponse.json({ ok: false, error: "缺少 userId" }, { status: 400 });

  const activeVideos = await prisma.video.count({
    where: { user: BigInt(userId), status: { in: [10, 20] } },
  });
  return NextResponse.json({ ok: true, activeVideos });
}
