// 玩家查看当前旁观者名单（2026-11-28 张老师需求）：练习页「N人正在旁观」
// hover 气泡使用。只允许读取自己的名单，不接受 uid 参数，避免旁路探测他人在看谁。
// 上线开关与其他 /api/watch/* 一致：服务器 .env 设 LIVE_ENABLED=0 即关闭。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { activeViewerSessions } from "@/lib/live-rep";
import { dualTitles } from "@/lib/title-system";
import { TITLES, TITLE_COLORS } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.LIVE_ENABLED === "0") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const active = activeViewerSessions(session.uid);
  if (!active.length) return NextResponse.json({ ok: true, viewers: [] });
  const firstAtMap = new Map(active.map((a) => [a.uid, a.firstAt]));
  const bigIds = active.map((a) => BigInt(a.uid));
  const now = Date.now();
  const [users, scores] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: bigIds } },
      select: { id: true, chineseName: true, sex: true, status: true },
    }),
    prisma.userScores.findMany({
      where: { id: { in: bigIds } },
      select: { id: true, expTime: true },
    }),
  ]);
  const scoreMap = new Map(scores.map((s) => [Number(s.id), Number(s.expTime ?? 0)]));
  const titleRows = users.map((u) => {
    const uid = Number(u.id);
    const expTime = scoreMap.get(uid) ?? 0;
    return { userId: uid, expTime, ranked: u.status === 0 && expTime > 0, sex: u.sex };
  });
  /* 一次取总司令动态阈值，逐人按当前高级成绩快照算军衔；排序直接复用 TITLES
     的高低顺序（预备役排最后），同军衔再按高级成绩、uid 保证稳定。 */
  const titles = await dualTitles(titleRows);
  const rows = users.map((u, i) => {
    const uid = Number(u.id);
    const title = titles[i].m;
    /* 旁观时长（2026-11-28 张老师定）：最小单位 1 分钟——按 floor 取整分钟，
       不足 1 分钟按 1 分钟计 */
    const sinceMin = Math.max(1, Math.floor((now - (firstAtMap.get(uid) ?? now)) / 60_000));
    return {
      uid,
      name: u.chineseName,
      sex: u.sex,
      title,
      titleColor: TITLE_COLORS[title] ?? "#939387",
      expTime: titleRows[i].expTime,
      sinceMin,
    };
  });
  const titleOrder = new Map<string, number>(TITLES.map((title, i) => [title, i]));
  rows.sort((a, b) => {
    const ar = a.title === "预备役" ? TITLES.length : titleOrder.get(a.title) ?? TITLES.length;
    const br = b.title === "预备役" ? TITLES.length : titleOrder.get(b.title) ?? TITLES.length;
    return ar - br || a.expTime - b.expTime || a.uid - b.uid;
  });
  return NextResponse.json({
    ok: true,
    viewers: rows.map(({ uid, name, sex, title, titleColor, sinceMin }) => ({ uid, name, sex, title, titleColor, sinceMin })),
  });
}
