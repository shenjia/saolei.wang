// 图形验证码发放：GET 返回 { id, svg }；前端点击可刷新（作废旧 id）

import { NextResponse } from "next/server";
import { makeCaptcha } from "@/lib/captcha";
import { rateLimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/net";

export async function GET(req: Request) {
  // 防 OCR 脚本批量取图：同 IP 每分钟最多 20 张
  if (!rateLimit(`captcha:${getClientIp(req)}`, 20, 60_000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { id, svg } = makeCaptcha();
  return NextResponse.json(
    { id, svg },
    { headers: { "Cache-Control": "no-store" } },
  );
}
