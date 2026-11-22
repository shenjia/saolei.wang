// 比赛参赛录像分页 API（GET /api/tournament/[id]/videos?page=1&size=20）
// 2026-11-13 五轮：详情页录像板块换 PageSlider，client 壳「加载更多」走本接口
// （前缀整批替换语义：page=1&size=N 取当前排序下最新 N 条，与 TourListFeed 同口径）。
// 2026-11-22 张老师需求：透传级别筛选（level）与表头排序（order/dir）——
// 「加载更多」取的是当前筛选+排序下的前缀，与页面 RSC 首屏数据同源同序。

import { NextResponse } from "next/server";
import { getTourVideosPage } from "@/lib/tournament";
import {
  VIDEO_LEVELS,
  VIDEO_LIST_ORDERS,
  type VideoLevel,
  type VideoListOrder,
  type VideoListDir,
} from "@/lib/config";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const compId = parseInt(id, 10);
  if (!Number.isInteger(compId) || compId <= 0) {
    return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 });
  }

  const sp = new URL(req.url).searchParams;
  const page = Math.max(parseInt(sp.get("page") ?? "1", 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(sp.get("size") ?? "20", 10) || 20, 1), 100);
  // 级别筛选（2026-11-22）：非法值忽略（回全部级别）
  const levelRaw = sp.get("level") ?? "";
  const level: VideoLevel | undefined = (VIDEO_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as VideoLevel)
    : undefined;
  // 表头排序（2026-11-22）：非法值回默认 id；dir 非法回该列默认方向
  const orderRaw = sp.get("order") ?? "";
  const order: VideoListOrder = (VIDEO_LIST_ORDERS as readonly string[]).includes(orderRaw)
    ? (orderRaw as VideoListOrder)
    : "id";
  const dirRaw = sp.get("dir");
  const dir: VideoListDir | undefined = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : undefined;
  // 搜索态透传（2026-11-22 张老师报「搜一个人再翻页变全部录像」bug）：作者/成绩/3BV，
  // 语义同页面（author 与 time/3bv 互斥；time 输入格式同 /video 如 16.6）
  const vAuthor = Math.max(parseInt(sp.get("vauthor") ?? "", 10) || 0, 0) || undefined;
  const vTimeRaw = (sp.get("vtime") ?? "").trim();
  const vTime =
    vTimeRaw && Number.isFinite(Number(vTimeRaw)) && Number(vTimeRaw) > 0 ? Number(vTimeRaw) : undefined;
  const vBvRaw = (sp.get("3bv") ?? "").trim();
  const vBv = vBvRaw && /^\d+$/.test(vBvRaw) ? parseInt(vBvRaw, 10) : undefined;

  const data = await getTourVideosPage(compId, page, size, {
    level,
    order,
    dir,
    author: vAuthor,
    time: vTime,
    bv: vBv,
  });
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return NextResponse.json({ ok: true, ...data, totalPages });
}
