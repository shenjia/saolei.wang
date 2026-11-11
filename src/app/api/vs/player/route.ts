// /vs 对决选择页配套接口（2026-11-11 张老师需求）：
// GET /api/vs/player?id=123 → { player: { 卡片 + 实力雷达字段 } } / 404
// 仅登录可用（页面本身有登录门槛，接口兜底）。装配走 lib/vspick（与
// /vs/[[...ids]] 统一路由的 URL 段预取同源）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVsPickPlayer } from "@/lib/vspick";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = parseInt(new URL(req.url).searchParams.get("id") ?? "", 10);
  if (!id) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const player = await getVsPickPlayer(id);
  if (!player) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ player });
}
