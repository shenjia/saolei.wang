// 个人信息卡片 JSON 接口（2026-09-23：全站点人名弹卡片浮层的数据源）
// GET /api/usercard/123 → UserCardData + own（是否当前登录者本人）

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserCards } from "@/lib/usercard";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const [session, cards] = await Promise.all([getSession(), getUserCards([uid])]);
  const card = cards.get(uid);
  if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ...card, own: session?.uid === uid });
}
