import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { ensureVisitorId, getClientIp } from "@/lib/visitor";

export const dynamic = "force-dynamic";

/**
 * 页面访问埋点上报（2026-10-16，参考 01xue.com /api/track/view）
 * body: { path: string, referrer?: string, clientId?: string }
 * - 管理员登录态（session 有效）访问照常落库，但打 isAdmin 标记：
 *   流量口径不变（保留管理员浏览），后台数据分析聚合时剔除 isAdmin 行
 * - 仅接受以 / 开头的站内路径，长度 ≤ 255；/api/ 与 /admin 一律跳过
 * - 同一访客同一路径 10 秒内重复上报去重（防刷新/往返刷量）
 * - vid cookie 沿用 ensureVisitorId（1 年长期身份）
 * - referrer 由前端传 document.referrer（sendBeacon 请求头里永远是本站，不可用）；
 *   外站来源只存域名，站内跳转存 internal，直达存 direct
 * - 会话：同 visitorId 30 分钟内视为同一会话，会话首条 PV 标 isEntry=true（落地页统计）
 */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** referrer 归类：外站 → 域名；本站 → internal；空 → direct */
function classifyReferrer(referrer: string | null | undefined, ownHosts: Set<string>): string | null {
  if (!referrer) return "direct";
  try {
    const url = new URL(referrer);
    const host = url.hostname.toLowerCase();
    if (ownHosts.has(host)) return "internal";
    return host.slice(0, 100);
  } catch {
    return "direct";
  }
}

/** UA 粗分类（够用即可，不做精确设备识别） */
function classifyUa(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  const s = ua.toLowerCase();
  if (/bot|crawler|spider|crawling/.test(s)) return "bot";
  if (/ipad|tablet/.test(s)) return "tablet";
  if (/mobile|iphone|android.*mobile/.test(s)) return "mobile";
  if (/iphone|android/.test(s)) return "mobile";
  return "desktop";
}

function ownHostsFromRequest(request: NextRequest): Set<string> {
  const hosts = new Set<string>();
  const xfHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = request.headers.get("host")?.split(":")[0];
  if (xfHost) hosts.add(xfHost.toLowerCase());
  if (host) hosts.add(host.toLowerCase());
  // 常见自指变体
  hosts.add("saolei.wang");
  hosts.add("www.saolei.wang");
  hosts.add("new.saolei.wang");
  hosts.add("dev.saolei.wang");
  hosts.add("localhost");
  hosts.add("127.0.0.1");
  return hosts;
}

export async function POST(request: NextRequest) {
  let body: { path?: string; referrer?: string; clientId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const path = typeof body.path === "string" ? body.path.split("?")[0].slice(0, 255) : "";
  if (
    !path.startsWith("/") ||
    path.startsWith("/api/") ||
    path.startsWith("/admin") ||
    /[%\s]/.test(path) // 脏 path 拦截（01xue 踩过截图工具把窗口尺寸拼进 URL）
  ) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // 页面实例 id：dwell beacon 靠它回写本行（前端生成，格式校验防注入）
  const clientId =
    typeof body.clientId === "string" && /^[a-z0-9]{6,32}$/.test(body.clientId)
      ? body.clientId
      : null;

  // 管理员登录态检测（结果随 PV 落库：isAdmin 标记 + userId，活跃玩家趋势用）
  const session = await getSession().catch(() => null);
  const isAdmin = !!session;
  const userId = session ? BigInt(session.uid) : null;

  const probe = NextResponse.json({});
  const { visitorId, response } = await ensureVisitorId(request, probe);

  // 10 秒去重窗口
  const nowMs = Date.now();
  const dedupeWindow = new Date(nowMs - 10 * 1000);
  const recent = await prisma.pageView.findFirst({
    where: { path, visitorId, createTime: { gte: Math.floor(dedupeWindow.getTime() / 1000) } },
    select: { id: true },
  });
  if (recent) {
    const res = NextResponse.json({ ok: true, deduped: true });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) res.headers.set("set-cookie", setCookie);
    return res;
  }

  // 会话判定：30 分钟窗口 + referrer 是否站内（外站进入 = 新会话）
  const ownHosts = ownHostsFromRequest(request);
  const refClass = classifyReferrer(body.referrer, ownHosts);
  const sessionWindow = Math.floor((nowMs - SESSION_GAP_MS) / 1000);
  const last = await prisma.pageView.findFirst({
    where: { visitorId, createTime: { gte: sessionWindow } },
    orderBy: { createTime: "desc" },
    select: { sessionId: true },
  });
  const isEntry = !last || refClass !== "internal";
  const sessionId =
    !isEntry && last?.sessionId
      ? last.sessionId
      : `${visitorId.slice(0, 12)}-${nowMs.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.slice(0, 64);

  await prisma.pageView.create({
    data: {
      path,
      visitorId,
      ip: getClientIp(request),
      ua: request.headers.get("user-agent")?.slice(0, 255) ?? null,
      uaClass: classifyUa(request.headers.get("user-agent")),
      referrer: refClass,
      isEntry,
      sessionId,
      isAdmin,
      userId,
      clientId,
      createTime: Math.floor(nowMs / 1000),
    },
  });

  const res = NextResponse.json({ ok: true });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) res.headers.set("set-cookie", setCookie);
  return res;
}
