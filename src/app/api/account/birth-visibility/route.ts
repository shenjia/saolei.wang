// 显示年龄与星座开关（2026-11-04 张老师）
// POST { hidden: boolean } —— 写 user.birth_hidden（true=个人主页资料不再显示年龄和星座）
// 响应 { ok: true, hidden }；未登录 401

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: { hidden?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body.hidden !== "boolean") {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.user.update({
    where: { id: BigInt(session.uid) },
    data: { birthHidden: body.hidden, updateTime: now },
  });
  return NextResponse.json({ ok: true, hidden: body.hidden });
}
