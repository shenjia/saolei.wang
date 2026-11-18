// 关注/粉丝列表分页 API（2026-11-18 张老师要求标准翻页控件）：
// GET /api/follow/list?type=following|followers&page=N[&uid=N]
// 登录必需。缺省 uid=viewer 自己；带 uid 时查他人列表（隐私闸：列表隐藏仅
// 本人与管理员可看）。返回 { rows, total }；每页 FOLLOW_LIST_PAGESIZE(20)。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFollowingList, getFollowerList } from "@/lib/follow";
import { prisma } from "@/lib/db";
import { FOLLOW_LIST_PAGESIZE, isManager } from "@/lib/config";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const type = p.get("type") === "followers" ? "followers" : "following";
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const uidRaw = parseInt(p.get("uid") ?? "", 10) || 0;
  const owner = uidRaw || session.uid;
  if (owner !== session.uid) {
    // 他人列表：隐私闸与页面级一致（隐藏仅本人与管理员可看）
    const row = await prisma.user.findUnique({
      where: { id: BigInt(owner) },
      select: {
        followListHidden: type === "following",
        followerListHidden: type === "followers",
      },
    });
    if (!row) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    const hidden = type === "following" ? row.followListHidden : row.followerListHidden;
    if (hidden && !isManager(session.role)) {
      return NextResponse.json({ error: "该用户已隐藏此列表" }, { status: 403 });
    }
  }
  const { rows, total } =
    type === "followers"
      ? await getFollowerList(owner, page, FOLLOW_LIST_PAGESIZE)
      : await getFollowingList(owner, page, FOLLOW_LIST_PAGESIZE);
  return NextResponse.json({ rows, total });
}
