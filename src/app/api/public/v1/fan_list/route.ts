// 公开 API · 用户侧粉丝列表（2026-11-19）
// GET /api/public/v1/fan_list?page=1 → 关注我的人（按关注时间倒序）
// 口径同 /api/public/v1/follow_list（详见该文件头注释）：只查 token 本人，
// 每页 20 条，行结构一致。

import { NextResponse } from "next/server";
import { userApiAuth } from "../_user";
import { getFollowerList, type FollowListRow } from "@/lib/follow";
import { FOLLOW_LIST_PAGESIZE } from "@/lib/config";

function rowOut(base: string, r: FollowListRow) {
  return {
    id: r.id,
    chineseName: r.chineseName,
    englishName: r.englishName,
    sex: r.sex,
    avatarUrl: r.avatar.startsWith("/uploads/")
      ? `${base}${r.avatar}`
      : r.avatar.startsWith("http")
        ? r.avatar
        : r.avatar === "1"
          ? `${base}/images/player/${r.id}.jpg`
          : "",
    createTime: r.createTime,
    title: r.title,
    classic: r.classic,
  };
}

export async function GET(req: Request) {
  const auth = await userApiAuth(req);
  if ("err" in auth) return auth.err;
  const page = Math.max(1, parseInt(new URL(req.url).searchParams.get("page") ?? "1", 10) || 1);
  const { rows, total } = await getFollowerList(auth.ident.uid, page, FOLLOW_LIST_PAGESIZE);
  const base = process.env.SITE_URL ?? new URL(req.url).origin;
  return NextResponse.json({
    rows: rows.map((r) => rowOut(base, r)),
    total,
    page,
    hasMore: page * FOLLOW_LIST_PAGESIZE < total,
  });
}
