// 公开赞助金额开关（2026-11-02 张老师）
// POST { hidden: boolean } —— 写 user.donate_hidden（true=个人主页数据统计隐藏赞助金额行）
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
    data: { donateHidden: body.hidden, updateTime: now },
  });
  return NextResponse.json({ ok: true, hidden: body.hidden });
}
