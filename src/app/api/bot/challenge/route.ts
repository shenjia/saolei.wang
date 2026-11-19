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
import { captchaNeighbors, type CaptchaAction, type CaptchaGame } from "@/core/src/lib/captcha-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/* 增量协议 v2（2026-11-10 张老师：每步 2.8KB 太费）：客户端 PUT 带 base＝当前
   64 格状态串（0未开/1已开/2旗），服务端只回 diff（变动格下标+state+num）+ 短
   token。基线不符（乱序/并发请求）自动回落全量。POST 开局不变（全量一次性）。
   响应从 ~2.4KB → ~1.1KB（token 占 ~1KB 不可减：AES-GCM 加密盘面信封）。 */
function deltaPayload(game: CaptchaGame, base: string | undefined): Record<string, unknown> {
  const states = game.cells.join("");
  if (typeof base !== "string" || base.length !== game.cells.length || !/^[012]+$/.test(base)) {
    return publicChallenge(game); // 全量回落
  }
  const diff: Array<{ i: number; s: number; n: number | null }> = [];
  for (let i = 0; i < game.cells.length; i++) {
    const s = game.cells[i];
    if (Number(base[i]) !== s) diff.push({ i, s, n: s === 1 ? game.nums[i] : null });
  }
  if (diff.length > game.cells.length / 2) return publicChallenge(game); // 变动过半不如全量
  return {
    width: game.width,
    height: game.height,
    board3bv: game.board3bv,
    won: game.won,
    lost: game.lost,
    moves: game.moves,
    states,
    diff,
  };
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
  if (Number(req.headers.get("content-length") ?? 0) > 4096) return json({ error: "请求过大" }, 413);
  let body: { token?: string; action?: CaptchaAction; cell?: number; base?: string };
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
  /* 踩雷定位（2026-11-10 张老师：踩雷要把点到的格子画成爆雷）：lost 时回传
     触发雷格下标——open＝所点格；chord＝邻域内第一个未开雷（与 applyCaptchaAction
     走子循环命中序一致）。只透出这一格，mines 全量仍不下发（open 场景客户端
     本就能从「点了即输」推出该格是雷，无增量信息）。 */
  let mineCell: number | null = null;
  if (result.game.lost) {
    const cell = body.cell!;
    if (body.action === "open") mineCell = result.game.mines[cell] ? cell : null;
    else {
      mineCell = captchaNeighbors(cell, result.game.width, result.game.height)
        .find((i) => result.game.cells[i] === 0 && result.game.mines[i]) ?? null;
    }
  }
  const res = json({
    token: result.token,
    ...deltaPayload(result.game, body.base),
    ...(mineCell !== null ? { mineCell } : {}),
  });
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
