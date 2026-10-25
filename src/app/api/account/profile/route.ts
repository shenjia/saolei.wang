// 保存个人资料（移植 forms/ProfileForm::saveToDb + 校验规则；2026-09-25 移除自我介绍字段，只保留爱好）

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { checkSensitiveAll, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { AREA_LIST } from "@/lib/config";
import { applyRankAreaChange } from "@/lib/userrank";

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

  // 地区（2026-10-25 张老师要求：修改资料可更换地区）：
  // 白名单内的值才允许写入；不在白名单但等于当前库值（历史遗留多地区「xx&xx」，
  // 表单「保持现状」选项）视为不修改；其余非法值 400
  const areaRaw = String(body.area ?? "");
  const uid = BigInt(session.uid);
  const prevUser = await prisma.user.findUnique({ where: { id: uid }, select: { area: true } });
  const prevArea = prevUser?.area ?? "";
  const areaLegal = (AREA_LIST as readonly string[]).includes(areaRaw);
  if (areaRaw !== "" && !areaLegal && areaRaw !== prevArea) {
    return NextResponse.json({ error: "地区不合法" }, { status: 400 });
  }

  // 个人资料公开展示（昵称/爱好/QQ/鼠标/鼠标垫），写库前过敏感词
  const hit = checkSensitiveAll([
    fields.qq, fields.nickname, fields.mouse, fields.pad, fields.interest,
  ]);
  if (!hit.ok) {
    logSensitiveHit("account.profile", session.uid, hit);
    return NextResponse.json({ error: sensitiveRejectMessage(hit, "保存") }, { status: 400 });
  }

  // 地区变化：user 与 user_rank 同事务维护（名次落盘的 area/area_pos 必须跟着搬位，
  // 否则用户主页/卡片显示旧区名次；每日 00:05 全量重建兜底）
  if (areaLegal && areaRaw !== prevArea) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: uid },
        data: {
          area: areaRaw,
          updateTime: BigInt(Math.floor(Date.now() / 1000)),
        },
      });
      await applyRankAreaChange(tx, session.uid, prevArea, areaRaw);
    });
  }

  await prisma.userInfo.update({
    where: { id: uid },
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
