// 排名模式专用入口：玩家点击「上传录像」后，服务端编码 EVF，再内部复用通用上传审核管线。
// 本接口不接受现成录像文件，也没有结算时自动调用路径。

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildRankedEvf } from "@/lib/evfwrite";
import type { OnlineEvent } from "@/lib/avfwrite";
import { canonicalizeOnlineEvents, repairWinningEvents } from "@/lib/avfwrite";
import { uploadVideo } from "@/app/api/video/upload/route";

const STANDARD = [
  { width: 8, height: 8, mines: 10 },
  { width: 16, height: 16, mines: 40 },
  { width: 30, height: 16, mines: 99 },
];
const MOUSE_CODES = new Set([1, 3, 5, 9, 11, 17, 33, 65]);

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  // 功能仍在 dev 调试，生产开放前同时关闭服务端入口，避免仅隐藏按钮却保留调用面。
  if (process.env.NODE_ENV === "production") return fail("排名模式暂未开放", 404);

  const session = await getSession();
  if (!session) return fail("请先登录", 401);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("请求格式错误");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("请求格式错误");
  }

  const width = Number(body.width), height = Number(body.height), mines = Number(body.mines);
  const spec = STANDARD.find((s) => s.width === width && s.height === height && s.mines === mines);
  if (!spec) return fail("排名模式只支持初级、中级、高级标准盘面");
  const board = body.board;
  if (!Array.isArray(board) || board.length !== width * height || board.some((v) => v !== 0 && v !== 1)) {
    return fail("盘面数据无效");
  }
  if (board.reduce<number>((sum, v) => sum + Number(v), 0) !== mines) return fail("雷数与盘面不一致");

  const bbbv = Number(body.bbbv), scoreCsec = Number(body.scoreCsec);
  if (!Number.isInteger(bbbv) || bbbv < 1 || bbbv > 65535) return fail("3BV 数据无效");
  if (!Number.isInteger(scoreCsec) || scoreCsec < 1 || scoreCsec > 99900) return fail("成绩时间无效");
  if (typeof body.nf !== "boolean" || typeof body.questionMarks !== "boolean") return fail("模式数据无效");

  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 200000) {
    return fail("事件流无效");
  }
  const events: OnlineEvent[] = [];
  let lastCsec = -1;
  for (const raw of body.events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("事件流无效");
    const e = raw as Record<string, unknown>;
    const mouse = Number(e.mouse), x = Number(e.x), y = Number(e.y), sec = Number(e.sec), hun = Number(e.hun);
    if (!MOUSE_CODES.has(mouse) || ![sec, hun].every(Number.isInteger) || ![x, y].every(Number.isFinite)) return fail("事件流无效");
    if (x < 0 || x > 65535 || y < 0 || y > 65535 || sec < 0 || hun < 0 || hun > 99) return fail("事件流无效");
    const csec = sec * 100 + hun;
    if (csec < lastCsec || csec > 99900) return fail("事件时间无效");
    lastCsec = csec;
    events.push({ mouse, x, y, sec, hun });
  }

  let evf: Uint8Array;
  try {
    // 签名口径（张老师 2026-10-26 定）：#用户ID + 中文姓名（站点玩家实名惯例）
    const playerRow = await prisma.user.findUnique({
      where: { id: BigInt(session.uid) },
      select: { chineseName: true },
    });
    /* 事件流先过与 AVF 下载同源的归一 + 胜局修复（canonicalizeOnlineEvents /
       repairWinningEvents，均自 avfwrite 导出）：双击手势归一成 mr、无猜重排局
       危险 chord 改逐格安全点击、末尾补开遗留非雷格——否则 ms-toollib（FlopPlayer）
       重放终盘雷格数 ≠ 雷数，报「不能播放没有扫完的录像」（2026-10-26 实证）。 */
    const canonical = canonicalizeOnlineEvents(events);
    const exportEvents = repairWinningEvents(width, height, board, body.questionMarks, canonical, scoreCsec);
    evf = buildRankedEvf({
      width, height, mines, board, bbbv, scoreCsec,
      events: exportEvents,
      questionMarks: body.questionMarks,
      nf: body.nf,
      player: `#${session.uid} ${playerRow?.chineseName ?? session.username}`,
      uniqueIdentifier: randomUUID(),
    });
  } catch {
    return fail("录像生成失败", 500);
  }

  // 携带原登录 Cookie 内部调用通用上传：MD5 去重、胜负校验、user_sig、待审入库、自动分拣全部同源。
  const form = new FormData();
  form.append("file", new File([evf as unknown as BlobPart], `ranked-${randomUUID()}.evf`, { type: "application/octet-stream" }));
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const internalReq = new Request(new URL("/api/video/upload", req.url), {
    method: "POST",
    headers,
    body: form,
  });
  return uploadVideo(internalReq, { rankedInternal: true });
}
