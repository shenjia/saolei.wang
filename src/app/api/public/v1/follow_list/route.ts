// 公开 API · 用户侧关注列表 / 粉丝列表（2026-11-19）
// GET /api/public/v1/follow_list?page=1  → 我关注的人（按关注时间倒序）
// GET /api/public/v1/fan_list?page=1     → 关注我的人（按关注时间倒序）
// 鉴权：X-Api-Key（scope=user）+ Bearer token；只查 token 本人（不收 uid 参数——
// 他人列表受隐私闸限制，站内也仅本人与管理员可看，公开 API 不开放他人视角）。
// 每页固定 20 条（站内 FOLLOW_LIST_PAGESIZE 同款），page 从 1 起。
// 返回 { rows, total, page, hasMore }；行结构与站内列表页同源（lib/follow.ts 装配）：
//   id / chineseName / englishName / sex / createTime（关注时间 Unix 秒）
//   / avatarUrl（头像完整 URL）/ title（军衔）/ classic（旧称号备选，null=无）。

import { NextResponse } from "next/server";
import { userApiAuth } from "../_user";
import { getFollowingList, getFollowerList, type FollowListRow } from "@/lib/follow";
import { FOLLOW_LIST_PAGESIZE } from "@/lib/config";

/** 行输出：avatar 标记位转完整 URL（与站内 usercard / me 接口同款解析） */
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

async function list(
  req: Request,
  side: "following" | "followers"
): Promise<NextResponse> {
  const auth = await userApiAuth(req);
  if ("err" in auth) return auth.err;

  const page = Math.max(1, parseInt(new URL(req.url).searchParams.get("page") ?? "1", 10) || 1);
  const { rows, total } =
    side === "following"
      ? await getFollowingList(auth.ident.uid, page, FOLLOW_LIST_PAGESIZE)
      : await getFollowerList(auth.ident.uid, page, FOLLOW_LIST_PAGESIZE);
  const base = process.env.SITE_URL ?? new URL(req.url).origin;
  return NextResponse.json({
    rows: rows.map((r) => rowOut(base, r)),
    total,
    page,
    hasMore: page * FOLLOW_LIST_PAGESIZE < total,
  });
}

export async function GET(req: Request) {
  return list(req, "following");
}
