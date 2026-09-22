// 审核操作（移植 VideoController::actionReview 的单录像审核分支）

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { reviewVideo } from "@/lib/review";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  let body: { id?: number | string; status?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const videoId = parseInt(String(body.id ?? ""), 10);
  const status = parseInt(String(body.status ?? ""), 10);
  if (!videoId || Number.isNaN(status)) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const result = await reviewVideo(session.uid, session.role, videoId, status);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
