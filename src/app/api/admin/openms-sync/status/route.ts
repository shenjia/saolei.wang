// 后台仪表盘「开源扫雷网录像同步」状态只读接口（2026-11-10）
// 首页概览卡每 10 秒轮询一次；纯只读，无任何触发/干预操作。
// 实时查库、no-store：跑批状态进缓存会骗人（与待审计数同源约定）。

import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/guard";
import { getOpenmsSyncStatus } from "@/lib/admin/openms-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdminApi();
  if ("error" in guard) return guard.error;
  try {
    const data = await getOpenmsSyncStatus();
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    console.error("[admin/openms-sync/status]", e);
    return NextResponse.json({ error: "状态查询失败" }, { status: 500 });
  }
}
