// 黑名单保存 API（2026-11-18 张老师需求 5）：
// POST { list: string }（textarea 原文，每行一个用户 id）
// 服务端 parse/serialize 清洗后整列覆盖 user.follow_blocklist；
// 响应 { ok: true, count }；未登录 401

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { serializeBlocklist } from "@/lib/follow";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: { list?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const text = String(body.list ?? "");
  // 清洗后长度闸（列 VarChar(4000)）：超长拒绝，提示拆分
  const cleaned = serializeBlocklist(text.split(/\r?\n/));
  if (cleaned.length > 4000) {
    return NextResponse.json({ error: "黑名单人数过多，请精简后再保存" }, { status: 400 });
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.user.update({
    where: { id: BigInt(session.uid) },
    data: { followBlocklist: cleaned, updateTime: now },
  });
  return NextResponse.json({ ok: true, count: cleaned ? cleaned.split("\n").length : 0 });
}
