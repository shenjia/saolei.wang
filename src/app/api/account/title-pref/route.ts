// 称号体系偏好设置（2026-10-17 Phase 5）
// POST { system: 'm' | 'c' } —— 写 user_info.title_pref（无行则建）
// 响应 { ok: true }；未登录 401

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { parseTitleSystem } from "@/lib/title-system";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: { system?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const system = parseTitleSystem(body.system);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.userInfo.upsert({
    where: { id: BigInt(session.uid) },
    create: { id: BigInt(session.uid), titlePref: system, createTime: now, updateTime: now },
    update: { titlePref: system, updateTime: now },
  });
  return NextResponse.json({ ok: true, system });
}
