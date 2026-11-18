// 账户设置隐私区 API（2026-11-18 张老师需求 5）：
// POST { field: "followList"|"followerList"|"followNotify", hidden: boolean }
// 分别写 user.follow_list_hidden / follower_list_hidden / follow_notify_disabled
// 响应 { ok: true, hidden }；未登录 401

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

const FIELD_COLUMN = {
  followList: "followListHidden",
  followerList: "followerListHidden",
  followNotify: "followNotifyDisabled",
} as const;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: { field?: string; hidden?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const column = FIELD_COLUMN[body.field as keyof typeof FIELD_COLUMN];
  if (!column || typeof body.hidden !== "boolean") {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.user.update({
    where: { id: BigInt(session.uid) },
    data: { [column]: body.hidden, updateTime: now },
  });
  return NextResponse.json({ ok: true, hidden: body.hidden });
}
