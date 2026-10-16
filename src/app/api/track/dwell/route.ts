import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 流失诊断埋点回写（2026-10-16，参考 01xue.com /api/track/dwell）
 * body: { clientId: string, dwellMs: number, scrollPct: number, clicked: boolean, firstClickHref?: string|null }
 * - 管理员登录态的 PV 照常回写（行上带 isAdmin 标记，后台数据分析聚合时剔除）
 * - clientId 是前端生成的页面实例 id（view beacon 已随 PV 落库），按它找回对应 page_view 行
 * - 同一页面实例会多次上报（hidden / pagehide / SPA 切换），值均为累计值，后写覆盖即可
 * - firstClickHref：首个点击目标的 href（仅 <a>），多次上报重复携带同一值
 * - 不上报 vid：dwell 不需要访客身份，避免多余 set-cookie；clientId 本身不可枚举（随机 24 字符）
 * - 找不到行（10s 去重被吞的 PV、老前端无 clientId）静默忽略
 */

const MAX_DWELL_MS = 24 * 3600 * 1000; // 挂页一整天的上限，防脏数据

export async function POST(request: NextRequest) {
  let body: {
    clientId?: string;
    dwellMs?: number;
    scrollPct?: number;
    clicked?: boolean;
    firstClickHref?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const clientId =
    typeof body.clientId === "string" && /^[a-z0-9]{6,32}$/.test(body.clientId)
      ? body.clientId
      : null;
  const dwellMs =
    typeof body.dwellMs === "number" && Number.isFinite(body.dwellMs)
      ? Math.min(Math.max(Math.round(body.dwellMs), 0), MAX_DWELL_MS)
      : null;
  const scrollPct =
    typeof body.scrollPct === "number" && Number.isFinite(body.scrollPct)
      ? Math.min(Math.max(Math.round(body.scrollPct), 0), 100)
      : null;

  if (!clientId || dwellMs === null) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // 首个点击目标：仅收字符串，截断 255 与列宽一致；未携带该字段的老前端不覆盖
  const firstClickHref =
    typeof body.firstClickHref === "string" && body.firstClickHref.trim() !== ""
      ? body.firstClickHref.slice(0, 255)
      : null;

  await prisma.pageView.updateMany({
    where: { clientId },
    data: {
      dwellMs,
      scrollPct,
      clicked: body.clicked === true,
      ...(body.firstClickHref !== undefined ? { firstClickHref } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
