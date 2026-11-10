// 行内「在我的主页展示」开关（2026-11-10 张老师：年龄/星座/赞助金额三行各配一个开关，
// 取代原页面底部的「显示年龄与星座」「公开赞助金额」两个独立开关）
// POST { field: "age" | "constellation" | "donate", hidden: boolean }
//   —— 分别写 user.age_hidden / user.constellation_hidden / user.donate_hidden
// 响应 { ok: true, hidden }；未登录 401

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

const FIELD_COLUMN = {
  age: "ageHidden",
  constellation: "constellationHidden",
  donate: "donateHidden",
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
