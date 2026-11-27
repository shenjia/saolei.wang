// 伪直播 rep 流（2026-11-27 张老师需求）：观众按 uid 轮询取该主播已封口的
// 局队列。粉丝闸：必须登录 + 已关注主播 + 未被主播拉黑；主播本人可看自己的。
// 上线开关：默认开启；紧急关闭在服务器 .env 设 LIVE_ENABLED=0（2026-11-27 张老师确认上线）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isBlocked, isFollowing } from "@/lib/follow";
import { recordClick } from "@/lib/star";
import { getIndex, isLiveNow, repUrl, sealIfStale, feedViewerTouch, viewerCount, getState } from "@/lib/live-rep";

/** 上线闸口（2026-11-27 张老师确认上线）：默认全站开启；
 *  紧急关闭只需在服务器 .env 设 LIVE_ENABLED=0（无需重新构建）。
 *  ⚠️ 不再用 host 前缀判断——nginx 配置变化即失效，且生产域名不叫 dev.* */
function liveEnabled(): boolean {
  return process.env.LIVE_ENABLED !== "0";
}

export const dynamic = "force-dynamic";

/* 人气去重镜像（2026-11-27 15:30 性能收口）：观众每 3s 拉一次 feed，原实现
   每次都发起 recordClick 事务——靠 click 表唯一键冲突兜底，等于每个观众
   每分钟 ~20 次注定失败的 INSERT+upsert 事务白跑（DB 无谓写放大）。
   这里按 `<观众>:<主播> -> 日期` 内存标记跳过当天重复；进程重启丢标记
   无妨，DB 唯一键仍是最终闸门。key 空间有限（活跃观众×主播），超阈值
   时惰性清掉非当日旧标记防膨胀 */
const liveStarMark = new Map<string, string>();
const todayKey = () => new Date().toISOString().slice(0, 10);

function recordLiveStarOnce(streamerUid: number, viewerUid: number, ip: string): void {
  const today = todayKey();
  const key = `${viewerUid}:${streamerUid}`;
  if (liveStarMark.get(key) === today) return;
  if (liveStarMark.size > 5_000) {
    for (const [k, d] of liveStarMark) {
      if (d !== today) liveStarMark.delete(k);
    }
  }
  liveStarMark.set(key, today);
  void recordClick(streamerUid, ip, "live");
}

export async function GET(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录并关注主播后观看" }, { status: 401 });
  const url = new URL(req.url);
  const uid = Number(url.searchParams.get("uid"));
  if (!Number.isInteger(uid) || uid <= 0) return NextResponse.json({ error: "主播非法" }, { status: 400 });
  if (uid !== session.uid) {
    if (await isBlocked(uid, session.uid)) {
      return NextResponse.json({ error: "由于该玩家的隐私设置，你无法旁观" }, { status: 403 });
    }
    if (!(await isFollowing(session.uid, uid))) {
      return NextResponse.json({ error: "请先关注主播后观看" }, { status: 403 });
    }
  }

  /* 主播关页/断线未发 final 时兜底封口（超时局），观众下一次轮询即可看到 */
  sealIfStale(uid);
  /* 观众在场计数（2026-11-27 14:12 张老师需求）：非本人拉 feed＝观众，
     心跳响应聚合后由主播练习页「x人旁观」显示 */
  if (uid !== session.uid) {
    feedViewerTouch(uid, session.uid);
    /* 旁观计人气（2026-11-27 14:33 张老师定）：观众给主播 +1 人气——
       recordClick 同 IP 同日同主播只计一次（去重闸门不变），来源标记 live；
       上方 recordLiveStarOnce 挡当天重复轮询的事务白跑（15:30 性能收口） */
    recordLiveStarOnce(uid, session.uid, req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "");
  }
  const idx = getIndex(uid);
  const sorted = [...idx.reps].sort((a, b) => b.at - a.at);
  /* 服务端选局（2026-11-27 19:31 张老师定）：观众带 played（已看过的
     gameId 列表，会话内追加上报），服务端只决策并返回**一条**——
     优先已完成局（won，18:54 口径），组内时长最长（scoreMs）；中间跳过
     的局随 skipped 一并下发，观众端标已播不再回看（跳播语义不变）。
     响应由全量队列 ~4KB 瘦身到单条 ~0.3KB */
  const played = new Set(
    (url.searchParams.get("played") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const candidates = sorted.filter((r) => !played.has(r.gameId));
  const wonPool = candidates.filter((r) => r.won);
  const pool = wonPool.length ? wonPool : candidates;
  const best = pool.length ? pool.reduce((a, b) => ((b.scoreMs || 0) > (a.scoreMs || 0) ? b : a)) : null;
  const rep = best ? { ...best, url: repUrl(uid, best.gameId) } : null;
  const skipped = best ? candidates.filter((c) => c.gameId !== best.gameId).map((c) => c.gameId) : [];
  /* 最新一局的级别（观众端棋盘尺寸跟随；无候选也返回） */
  const lastLevel = sorted[0]?.level ?? null;
  /* 当前局完成百分比（2026-11-27 19:21 张老师定）：直播中带回主播当前局
     「已开安全格÷总安全格」——观众端「对局中」气泡/按钮显示；停止/离线不带 */
  const stNow = getState(uid);
  const live = isLiveNow(uid);
  const progress = live && stNow ? stNow.progress ?? null : null;
  /* 主播当前局 gameId（2026-11-27 22:29 张老师定）：观众端区分「主播已开
     新局还在局中（对局中+进度）」vs「主播停在上一局结算画面未开新局
     （等待玩家开始，不显示旧局进度残留）」——与观众已看的录像 gameId 对比 */
  const curGameId = stNow?.gameId ?? null;
  /* 比赛模式（2026-11-27 20:30 张老师定）：直播中带回比赛 id+全称+倒计时
     终点——观看页标题行「正在参加xxx（剩余…）」（详情页新标签链接）；
     非比赛/离线不带 */
  const comp = live && stNow?.compId
    ? { id: stNow.compId, name: stNow.compName ?? "", end: stNow.compEnd ?? 0 }
    : null;
  /* 旁观数（2026-11-27 14:18 张老师需求：观看页标题行「x人正在旁观」）——
     观众拉 feed 的同时返回当前旁观人数（含自己） */
  return NextResponse.json({ ok: true, uid, live, viewers: viewerCount(uid), progress, curGameId, comp, rep, skipped, lastLevel });
}
