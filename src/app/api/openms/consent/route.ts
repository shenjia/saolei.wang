// 开源扫雷网同步表态（2026-11-07 张老师需求）
// POST { choice: "agree" | "disagree" } —— 记录绑定用户对历史录像同步的表态；
// 「不同意」名单在同步 worker 中跳过。仅已绑定（openms_link 有行）用户可表态。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { setOpenmsConsent } from "@/lib/openms";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const choice = (body as { choice?: string })?.choice;
  if (choice !== "agree" && choice !== "disagree") {
    return NextResponse.json(
      { error: "bad_request", message: "choice 需为 agree 或 disagree" },
      { status: 400 }
    );
  }
  const ok = await setOpenmsConsent(session.uid, choice === "agree" ? 1 : 2);
  if (!ok) {
    return NextResponse.json(
      { error: "not_bound", message: "未找到开源扫雷网绑定关系" },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}
