// 后台写操作统一接口（2026-09-24）
// 只有这一个入口：前端传 { op, ...params }，服务端按 op 决定所需权限并执行。
// 权限与参数校验都在 lib/admin/ops.ts，接口层只管解析与状态码。

import { NextResponse } from "next/server";
import { clientIp, requireAdminApi } from "@/lib/admin/guard";
import { OP_LEVELS, runOp } from "@/lib/admin/ops";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }

  const op = String(body.op ?? "");
  const level = OP_LEVELS[op];
  if (!level) return NextResponse.json({ ok: false, error: `未知操作：${op || "(空)"}` }, { status: 400 });

  const guard = await requireAdminApi(level);
  if ("error" in guard) return guard.error;

  const { op: _drop, ...params } = body;
  void _drop;

  try {
    const ip = await clientIp();
    const result = await runOp(op, params, guard.session, ip);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    console.error("[admin/action]", op, e);
    return NextResponse.json({ ok: false, error: "服务端异常，已记录日志" }, { status: 500 });
  }
}
