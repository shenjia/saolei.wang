// 人气上报（2026-11-09 张老师定：人气计数从页面渲染剥离到客户端 API）
// 背景：/user/ 等页面要挂 nginx 整页缓存（无 session cookie 的游客请求缓存 60s），
// 服务端渲染期计人气会把缓存命中误判为「无人访问」、且缓存 HTML 无法区分访客 IP。
// 剥离后：页面只渲染人气展示值（getClicks），计数由客户端 ClickTracker 组件
// 异步上报本端点；服务端保留 recordClick 全部闸门（同 IP 同日同来源去重、
// 跨来源去重、事务性 user_stat.clicks 累计），不带 JS 的爬虫天然不计人气。
// body: { userId: number, source: "home" | "card" | "star" }
import { NextRequest, NextResponse } from "next/server";
import { recordClick } from "@/lib/star";
import { getClientIp } from "@/lib/visitor";

export const runtime = "nodejs";

const SOURCES = new Set(["home", "card", "star"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const userId = Number(body.userId);
  const source = String(body.source ?? "home");
  if (!Number.isInteger(userId) || userId <= 0 || userId > 4_000_000) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!SOURCES.has(source)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const ip = getClientIp(req);
  if (!ip) return NextResponse.json({ ok: false }, { status: 400 });
  // 去重闸门在 recordClick 内（click 唯一键冲突即忽略），失败静默不重试
  await recordClick(userId, ip, source as "home" | "card" | "star");
  return NextResponse.json({ ok: true });
}
