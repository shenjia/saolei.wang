// 排行局旁观心跳（2026-11-27 张老师需求）：客户端排行局每 3 秒上报当前
// gameId + level，服务端拉权威快照落 pending EVF；换局/局终 final 时封口成
// 一局完整 rep 供粉丝观看。登录会话绑定 uid——只能给自己的局落 rep。
// 上线开关：默认开启；紧急关闭在服务器 .env 设 LIVE_ENABLED=0（2026-11-27 张老师确认上线）。
// 年龄闸（2026-11-28 合规改造）：已填生日且未满 16 周岁的用户，非 final 心跳一律 403
// （＝不公开发布练习状态）；final 心跳放行但强制 allow=false（本局 rep 仍封口不丢，
// 只是不公开）。判定见 lib/live-age.ts（与客户端 SSR 同源）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { heartbeat, viewerCount } from "@/lib/live-rep";
import { LEVELS, type VideoLevel } from "@/lib/config";
import { liveUnder16Of } from "@/lib/live-age";

/** 上线闸口（2026-11-27 张老师确认上线）：默认全站开启；
 *  紧急关闭只需在服务器 .env 设 LIVE_ENABLED=0（无需重新构建）。
 *  ⚠️ 不再用 host 前缀判断——nginx 配置变化即失效，且生产域名不叫 dev.* */
function liveEnabled(): boolean {
  return process.env.LIVE_ENABLED !== "0";
}

export async function POST(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: { gameId?: unknown; level?: unknown; final?: unknown; allow?: unknown; compId?: unknown; compEnd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body.gameId !== "string") return NextResponse.json({ error: "gameId 非法" }, { status: 400 });
  const final = body.final === true;
  /* 年龄闸：已填生日且未满 16 周岁 → 不公开发布。final 心跳例外放行（封口用），
     下面强制 allow=false。心跳 3s 一次，查询走主键单行，开销可忽略 */
  const under16 = await liveUnder16Of(session.uid);
  if (under16 && !final) {
    return NextResponse.json({ error: "age_gate", state: "under16" }, { status: 403 });
  }
  const level = typeof body.level === "string" && (LEVELS as readonly string[]).includes(body.level)
    ? body.level as VideoLevel
    : "beg";
  /* allow：允许旁观开关（缺省 true——老客户端不带该字段按允许处理）。
     ⚠️ under16 恒 false——客户端传什么都不得公开 */
  const allow = !under16 && (body.allow === undefined ? true : body.allow !== false);
  /* 比赛模式（2026-11-27 20:30 张老师定）：练习页 comp.id 透传——>0 落 state
     供观众端「正在比赛」展示；非比赛局不带字段/0 → state 清空 */
  const compId = Number.isInteger(body.compId) && (body.compId as number) > 0
    ? (body.compId as number)
    : undefined;
  const compEnd = Number.isInteger(body.compEnd) && (body.compEnd as number) > 0
    ? (body.compEnd as number)
    : undefined;
  const result = await heartbeat(session.uid, body.gameId, level, final, allow, compId, compEnd);
  if (!result.ok) return NextResponse.json({ error: result.error || "心跳失败" }, { status: 400 });
  /* 观众数（2026-11-27 14:12 张老师需求）：练习页「自定义」tab 变「x人旁观」
     ——非 0 时客户端换文案（live=true 且 allow 才有意义；关旁观/离线恒 0） */
  const viewers = allow ? viewerCount(session.uid) : 0;
  return NextResponse.json({ ok: true, sealed: result.sealed?.length ?? 0, viewers });
}
