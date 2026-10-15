// 共享 SMTP 发信助手（nodemailer）
// SMTP_* 环境变量：HOST / PORT / USER / PASS / FROM；未配置时 smtpConfigured()=false
// 注意：阿里云邮件推送 smtpdm.aliyun.com 的 465 SSL 端点对新发信地址会 535 拒认证，
// 80 端口（secure:false，nodemailer 自动 STARTTLS）同凭据可用（2026-10-15 实测）

import nodemailer from "nodemailer";

export function smtpConfigured(): boolean {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP 未配置");
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT ?? "80", 10),
    secure: (SMTP_PORT ?? "80") === "465",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  // From 带显示名「扫雷网」：裸地址时 Apple Mail 等客户端会拿 local part 取首字母
  // 显示「No」头像（2026-10-15 张老师截图反馈），带显示名后显示「扫」
  await transporter.sendMail({
    from: { name: "扫雷网", address: SMTP_FROM ?? SMTP_USER },
    to,
    subject,
    text,
  });
}
