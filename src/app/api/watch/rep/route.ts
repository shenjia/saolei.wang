// 已封口 rep 鉴权下发（2026-11-27 15:30 安全收口）：rep 存储已迁出 public
// （data/live-rep/，静态路径不可达），观看端一律经此路由拉取——粉丝闸与
// feed 完全同口径（登录 + 已关注 + 未被拉黑；被旁观玩家本人可看自己的）。
// pending 是进行中局快照（含完整雷位），readSealedRep 只读 reps/，不下发。
// 上线开关：默认开启；紧急关闭在服务器 .env 设 LIVE_ENABLED=0（2026-11-27 张老师确认上线）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isBlocked, isFollowing } from "@/lib/follow";
import { readSealedRep } from "@/lib/live-rep";

/** 上线闸口（2026-11-27 张老师确认上线）：默认全站开启；
 *  紧急关闭只需在服务器 .env 设 LIVE_ENABLED=0（无需重新构建）。
 *  ⚠️ 不再用 host 前缀判断——nginx 配置变化即失效，且生产域名不叫 dev.* */
function liveEnabled(): boolean {
  return process.env.LIVE_ENABLED !== "0";
}

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录并关注玩家后观看" }, { status: 401 });
  const url = new URL(req.url);
  const uid = Number(url.searchParams.get("uid"));
  const gameId = url.searchParams.get("gameId") ?? "";
  if (!Number.isInteger(uid) || uid <= 0) return NextResponse.json({ error: "玩家非法" }, { status: 400 });
  if (uid !== session.uid) {
    if (await isBlocked(uid, session.uid)) {
      return NextResponse.json({ error: "由于该玩家的隐私设置，你无法旁观" }, { status: 403 });
    }
    if (!(await isFollowing(session.uid, uid))) {
      return NextResponse.json({ error: "请先关注玩家后观看" }, { status: 403 });
    }
  }
  const data = readSealedRep(uid, gameId);
  if (!data) return NextResponse.json({ error: "录像不存在" }, { status: 404 });
  /* 二进制直出（EVF）；no-store——观看权是会话相关的，绝不进任何缓存 */
  return new NextResponse(Buffer.from(data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
