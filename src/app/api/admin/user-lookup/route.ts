// 玩家识别接口（2026-10-30 后台赞助登记表单）
// 输入 ID 实时回显玩家信息，防手滑记错账。只读、管理员权限。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin/guard";
import { getThunderKingId } from "@/lib/title-system";
import { title as assessTitle } from "@/lib/assess";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireAdminApi("manager");
  if ("error" in guard) return guard.error;

  const id = parseInt(new URL(req.url).searchParams.get("id") ?? "", 10);
  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const [user, score, king] = await Promise.all([
    prisma.user.findUnique({
      where: { id: BigInt(id) },
      select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
    }),
    prisma.userScores.findUnique({ where: { id: BigInt(id) }, select: { expTime: true } }),
    getThunderKingId(),
  ]);
  if (!user) return NextResponse.json({ ok: true, found: false });

  return NextResponse.json({
    ok: true,
    found: true,
    user: {
      id,
      chineseName: user.chineseName,
      englishName: user.englishName,
      sex: user.sex,
      banned: user.status === -1,
      // 军衔按实时高级成绩评定（与玩家管理列表同口径）
      title: await assessTitle(Number(score?.expTime ?? 0), king > 0 && king === id),
    },
  });
}
