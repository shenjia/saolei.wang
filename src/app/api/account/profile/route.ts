// 保存个人资料（移植 forms/ProfileForm::saveToDb + 校验规则；2026-09-25 移除自我介绍字段，只保留爱好）

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

const LIMITS = { qq: 15, nickname: 10, mouse: 30, pad: 30, interest: 50 } as const;
const LABELS: Record<string, string> = {
  qq: "QQ", nickname: "昵称", mouse: "鼠标", pad: "鼠标垫", interest: "爱好",
};

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  // 长度校验（按 utf-8 字符数，移植 ProfileForm::rules）
  const fields: Record<string, string> = {};
  for (const [key, limit] of Object.entries(LIMITS)) {
    const value = String(body[key] ?? "").trim();
    if ([...value].length > limit) {
      return NextResponse.json({ error: `${LABELS[key]}不能超过${limit}个字` }, { status: 400 });
    }
    fields[key] = value;
  }

  // 生日：三个都选才更新；任一缺失视为不修改（移植 checkdate）
  const y = parseInt(String(body.birthYear ?? ""), 10) || 0;
  const m = parseInt(String(body.birthMonth ?? ""), 10) || 0;
  const d = parseInt(String(body.birthDay ?? ""), 10) || 0;
  let birthday: bigint | undefined;
  if (y && m && d) {
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      return NextResponse.json({ error: "生日不是有效日期" }, { status: 400 });
    }
    if (date.getTime() > Date.now()) {
      return NextResponse.json({ error: "生日不能是将来的日期" }, { status: 400 });
    }
    birthday = BigInt(Math.floor(date.getTime() / 1000));
  }

  await prisma.userInfo.update({
    where: { id: BigInt(session.uid) },
    data: {
      qq: fields.qq,
      nickname: fields.nickname,
      mouse: fields.mouse,
      pad: fields.pad,
      interest: fields.interest,
      ...(birthday !== undefined ? { birthday } : {}),
      updateTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
  return NextResponse.json({ ok: true });
}
