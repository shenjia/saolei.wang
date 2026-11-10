// 公开 API · 开源扫雷网绑定关系列表（2026-11-09 绑定协议 v2）
// GET /api/public/v1/openms/links
// 鉴权：无（协议定案「不做 API KEY」；本接口供合作站点按需拉取，请控制频率）。
//
// 用途：
// 1. 开源扫雷网维护自己的绑定关系表（profile ↔ 雷网 uid 映射）；
// 2. 开源扫雷网发起绑定的核销：雷网授权页确认后，绑定关系出现在此列表即完成。
//
// 协议口径（2026-11-10 张老师定）：两站各抓各的。本列表只返回绑定关系本身，不携带任何一方的
// 同步开关；开源站是否抓取雷网录像由开源站自行决定，雷网管不到，也不在本库保存该设定。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const rows = await prisma.openmsLink.findMany({
    select: { user: true, profile: true },
  });
  // 申请者用户名一并给出（开源扫雷网展示「绑定的雷网账户」用）；老账号可能无 user_auth 行，回退中文名
  const ids = rows.map((r) => r.user);
  const [users, urows] = await Promise.all([
    prisma.userAuth.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } }),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, chineseName: true } }),
  ]);
  const nameById = new Map<string, string>();
  for (const u of urows) nameById.set(u.id.toString(), u.chineseName ?? "");
  for (const u of users) nameById.set(u.id.toString(), u.username);

  return NextResponse.json({
    generatedAt: Math.floor(Date.now() / 1000),
    links: rows.map((r) => ({
      profile: r.profile,
      uid: Number(r.user),
      username: nameById.get(r.user.toString()) ?? "",
    })),
  });
}
