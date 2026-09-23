// 扫雷历程 API（仅本人可操作）
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { addHistory, deleteHistory, updateHistory } from "@/lib/history";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const content = String(body.content ?? "").trim().slice(0, 500);

  if (action === "add") {
    const month = String(body.month ?? "");
    if (!MONTH_RE.test(month)) return NextResponse.json({ error: "月份格式应为 YYYY-MM" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    const id = await addHistory(session.uid, month, content);
    if (!id) return NextResponse.json({ error: "该月份已有历程，请直接编辑" }, { status: 409 });
    return NextResponse.json({ id });
  }

  const id = parseInt(String(body.id ?? ""), 10);
  if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  if (action === "update") {
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    const ok = await updateHistory(id, session.uid, content);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "无权修改" }, { status: 403 });
  }
  if (action === "delete") {
    const ok = await deleteHistory(id, session.uid);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "无权删除" }, { status: 403 });
  }
  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
