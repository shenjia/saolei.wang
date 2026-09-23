// 邮箱找回密码（新版测试.txt 需求，替代 2008 版密保问答+明文显示）
// token 30 分钟有效、一次性；邮件走 SMTP_* 环境变量，未配置时链接打到服务端日志（开发用）

import { createHash, randomBytes } from "crypto";
import nodemailer from "nodemailer";
import { prisma } from "./db";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
export const RESET_TOKEN_TTL = 30 * 60; // 30 分钟

/** 生成重置令牌（库中只存 sha256，不存明文 token） */
export async function createResetToken(email: string): Promise<{ token: string; userId: number } | null> {
  const auth = await prisma.userAuth.findUnique({ where: { username: email } });
  if (!auth) return null;
  const token = randomBytes(32).toString("hex");
  const hashed = createHash("sha256").update(token).digest("hex");
  const now = nowSec();
  await prisma.passwordToken.create({
    data: { user: auth.id, token: hashed, used: false, createTime: now, updateTime: now },
  });
  return { token, userId: N(auth.id) };
}

/** 校验并消费令牌，返回用户 id（过期/已用/不存在返回 null） */
export async function consumeResetToken(token: string): Promise<number | null> {
  const hashed = createHash("sha256").update(token).digest("hex");
  const row = await prisma.passwordToken.findUnique({ where: { token: hashed } });
  if (!row || row.used) return null;
  if (N(row.createTime) + RESET_TOKEN_TTL < Math.floor(Date.now() / 1000)) return null;
  await prisma.passwordToken.update({
    where: { id: row.id },
    data: { used: true, updateTime: nowSec() },
  });
  return N(row.user);
}

/** 发送重置邮件；未配置 SMTP 时打印链接到日志并返回 false */
export async function sendResetEmail(email: string, resetUrl: string): Promise<boolean> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[password-reset] SMTP 未配置，重置链接（仅开发可见）: ${resetUrl}`);
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT ?? "465", 10),
    secure: (SMTP_PORT ?? "465") === "465",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: SMTP_FROM ?? SMTP_USER,
    to: email,
    subject: "扫雷网密码重置",
    text: `您申请了扫雷网密码重置，请点击以下链接（30 分钟内有效）：\n\n${resetUrl}\n\n如果这不是您的操作，请忽略本邮件。`,
  });
  return true;
}
