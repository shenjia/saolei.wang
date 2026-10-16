// 录像搜索框 ID 探测接口（2026-10-16 张老师需求：搜索框支持录像 ID 查询）：
// GET /api/video/lookup?id=<纯数字> → { video: { id, level, status, uploadUser, chineseName } } | { video: null }
// 纯整数输入防抖后调用：命中 → 下拉追加「录像 #ID（级别 · 上传者）」项；回车/点击直达 /video/<id>。
// status=0（屏蔽）视同不存在——屏蔽录像在列表与详情页均不可见，搜索不应成为泄露入口。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const id = parseInt((p.get("id") ?? "").replace(/\D/g, ""), 10);
  if (!id) return NextResponse.json({ video: null });

  const rows = await prisma.$queryRawUnsafe<{
    id: bigint;
    level: string;
    status: number;
    chinese_name: string;
  }[]>(
    `SELECT v.id, v.level, v.status, u.chinese_name
     FROM video v JOIN user u ON u.id = v.user
     WHERE v.id = ? LIMIT 1`,
    id
  );
  const row = rows[0];
  if (!row || row.status === 0) return NextResponse.json({ video: null });

  return NextResponse.json({
    video: {
      id: Number(row.id),
      level: row.level,
      chineseName: row.chinese_name,
    },
  });
}
