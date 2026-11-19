// 关注状态批量查询（2026-11-18 列表翻页补查用）：
// GET /api/follow/status?uids=1,2,3 → { ids: [已关注的 uid] }
// 登录必需；服务端按 session 取 viewer。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { followingSet } from "@/lib/follow";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const uids = (p.get("uids") ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 100);
  const ids = [...(await followingSet(session.uid, uids))];
  return NextResponse.json({ ids });
}
