// 公开 API · 用户侧取关（2026-11-19）
// POST /api/public/v1/unfollow  body: { uid }
// 鉴权与业务口径同 /api/public/v1/follow（详见该文件头注释）；
// 单独拆成独立路径，客户端语义直观（关注/取关各一个端点，不再用 action 区分）。

import { NextResponse } from "next/server";
import { userApiAuth, readJson, parseIntParam, maintenanceGate } from "../_user";
import { unfollowUser } from "@/lib/follow";

export async function POST(req: Request) {
  const auth = await userApiAuth(req);
  if ("err" in auth) return auth.err;
  const gate = await maintenanceGate();
  if (gate) return gate;

  const body = await readJson(req);
  const uid = parseIntParam(body.uid);
  if (!uid) {
    return NextResponse.json({ error: "bad_request", message: "需提供 uid（正整数）" }, { status: 400 });
  }
  const err = await unfollowUser(auth.ident.uid, uid);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  return NextResponse.json({ ok: true });
}
