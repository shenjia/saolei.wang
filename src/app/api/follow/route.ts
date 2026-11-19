// 关注 API（2026-11-18 张老师需求）：POST { action: "follow"|"unfollow", uid }
// 登录必需；黑名单/封禁/自关注闸门在 lib/follow.ts；成功 { ok: true }
// 关注/取关动态与新粉丝提醒在 followUser/unfollowUser 内一并落库

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { followUser, unfollowUser } from "@/lib/follow";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";

export async function POST(req: Request) {
  if (await isMaintenanceOn()) return maintenanceReject() as unknown as NextResponse;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: { action?: string; uid?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const uid = parseInt(String(body.uid ?? ""), 10);
  if (!uid) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const err =
    body.action === "follow"
      ? await followUser(session.uid, uid)
      : body.action === "unfollow"
        ? await unfollowUser(session.uid, uid)
        : "未知操作";
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  return NextResponse.json({ ok: true });
}
