// 黑名单保存 API（2026-11-18 张老师需求 5）：
// POST { list: string }（textarea 原文，每行一个用户 id）
// 服务端 serializeBlocklist 清洗后整列覆盖 user.follow_blocklist；
// 联动清理（同日 23:28 张老师定）：双向解除关注——从自己的关注列表移除
// 黑名单所有 id、从黑名单所有用户的关注列表移除自己（parseBlocklistIds 严格
// 数字白名单校验防注入，查询全 Prisma 参数化零拼接）；
// 响应 { ok: true, count }；未登录 401

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { serializeBlocklist, parseBlocklistIds, applyBlocklistCleanup } from "@/lib/follow";

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
  // 联动清理：双向解除与黑名单用户的关注关系（严格数字校验后参数化删除）
  const { removedMine, removedTheirs } = await applyBlocklistCleanup(
    session.uid,
    parseBlocklistIds(cleaned)
  );
  if (removedMine + removedTheirs > 0) {
    console.log(
      `[blocklist-cleanup] uid=${session.uid} 移除关注：我→黑名单 ${removedMine} 行、黑名单→我 ${removedTheirs} 行`
    );
  }
  return NextResponse.json({ ok: true, count: cleaned ? cleaned.split("\n").length : 0 });
}
