import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  createChallenge,
  issueRscPass,
  moveChallenge,
  newRscId,
  publicChallenge,
  RSC_ID_COOKIE,
  RSC_PASS_COOKIE,
  RSC_PASS_TTL_SEC,
} from "@/lib/bot-challenge";
import type { CaptchaAction } from "@/core/src/lib/captcha-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const jar = await cookies();
  const existing = jar.get(RSC_ID_COOKIE)?.value;
  const owner = existing && /^[a-f0-9]{32}$/.test(existing) ? existing : newRscId();
  const { token, game } = createChallenge(owner, req.headers.get("user-agent"));
  const res = json({ token, ...publicChallenge(game) });
  if (!existing || existing !== owner) {
    res.cookies.set(RSC_ID_COOKIE, owner, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 365 * 24 * 3600,
    });
  }
  return res;
}

export async function PUT(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? 0) > 2048) return json({ error: "请求过大" }, 413);
  let body: { token?: string; action?: CaptchaAction; cell?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "请求格式错误" }, 400);
  }
  if (
    typeof body.token !== "string" || body.token.length > 12000 ||
    !["open", "flag", "chord"].includes(body.action ?? "") ||
    !Number.isInteger(body.cell)
  ) return json({ error: "请求格式错误" }, 400);

  const jar = await cookies();
  const owner = jar.get(RSC_ID_COOKIE)?.value ?? "";
  const result = moveChallenge({
    token: body.token!,
    owner,
    userAgent: req.headers.get("user-agent"),
    action: body.action!,
    cell: body.cell!,
  });
  if (!result) return json({ error: "验证局已失效，请换一局" }, 410);
  const res = json({ token: result.token, ...publicChallenge(result.game) });
  if (result.passed) {
    res.cookies.set(RSC_PASS_COOKIE, issueRscPass(owner, req.headers.get("user-agent")), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: RSC_PASS_TTL_SEC,
    });
  }
  return res;
}
