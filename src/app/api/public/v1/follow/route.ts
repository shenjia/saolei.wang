// 公开 API · 用户侧关注/取关（2026-11-19）
// POST /api/public/v1/follow    body: { uid }        → 关注
// POST /api/public/v1/unfollow  body: { uid }        → 取关
// 鉴权：X-Api-Key（scope=user）+ Bearer token；身份从 token 推导。
// 业务逻辑与站内 /api/follow 完全同源（lib/follow.ts）：
//   · 关注闸门：不能关注自己 → 用户不存在/封禁 → 黑名单 → 幂等（已关注直接成功）
//     → 关注上限（默认 30，赞助每元 +5 封顶 200）；
//     成功发关注动态（type 55）+ 新粉丝提醒（1h 合并窗口）。
//   · 取关幂等：未关注直接成功；发取关动态（type 56）。
//   · 紧邻抵消：先取关又关注（或反之）两条动态互相抵消。
// 维护模式挡写操作（与站内同款 503）。

import { NextResponse } from "next/server";
import { userApiAuth, readJson, parseIntParam, maintenanceGate } from "../_user";
import { followUser, unfollowUser } from "@/lib/follow";

async function handle(req: Request, action: "follow" | "unfollow") {
  const auth = await userApiAuth(req);
  if ("err" in auth) return auth.err;
  const gate = await maintenanceGate();
  if (gate) return gate;

  const body = await readJson(req);
  const uid = parseIntParam(body.uid);
  if (!uid) {
    return NextResponse.json({ error: "bad_request", message: "需提供 uid（正整数）" }, { status: 400 });
  }
  const err =
    action === "follow" ? await followUser(auth.ident.uid, uid) : await unfollowUser(auth.ident.uid, uid);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  return handle(req, "follow");
}
