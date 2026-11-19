// 「换成 QQ 头像」确认接口（2026-10-27 张老师要求：绑定 QQ 时本人已有照片，
// 由浮窗询问后才替换）
//
// 与自动同步（lib/oauth-avatar.ts importQqAvatar）同一套落盘 + 审核口径，区别只有
// force=true —— 绕过「本人已有照片 / 自传头像待审」两道闸门，因为用户已在浮窗里
// 明确点了「换成 QQ 头像」。
//
// 不变的口径：**不直接改 user.avatar**，一律落 avatar_review(PENDING) 进人工队列；
// 通过才写入并生效，驳回就只是队列记录变驳回态 —— 原头像全程照常展示。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { importQqAvatar } from "@/lib/oauth-avatar";

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const bind = await prisma.userOauth.findFirst({
    where: { userId: BigInt(session.uid), provider: "qq" },
    select: { avatar: true },
  });
  if (!bind?.avatar) {
    return NextResponse.json(
      { error: "没找到该 QQ 的头像，请重新绑定 QQ 或直接在「修改资料」上传照片" },
      { status: 400 },
    );
  }

  const result = await importQqAvatar(session.uid, bind.avatar, { force: true });
  if (result !== "queued") {
    return NextResponse.json(
      { error: "QQ 头像获取失败，请稍后在「修改资料」里上传照片" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, message: "QQ 头像已提交审核，通过后自动生效" });
}
