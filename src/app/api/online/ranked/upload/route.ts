// 排名模式专用入口：玩家点击「上传录像」后，服务端编码 EVF，再内部复用通用上传审核管线。
// 本接口不接受现成录像文件，也没有结算时自动调用路径。

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { buildRankedEvf } from "@/lib/evfwrite";
import type { OnlineEvent } from "@/lib/avfwrite";
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
    evf = buildRankedEvf({
      width, height, mines, board, bbbv, scoreCsec, events,
      questionMarks: body.questionMarks,
      nf: body.nf,
      player: `#${session.uid} ${session.username}`,
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
