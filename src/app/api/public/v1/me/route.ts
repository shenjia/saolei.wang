// 公开 API · 用户登录态自检 + 个人资料（2026-11-09）
// GET /api/public/v1/me
// 鉴权：Authorization: Bearer <token>（lib/usertoken.ts，login 签发的 7 天 token）。
//
// 2026-11-09（张老师需求）在原 { id, username, role } 基础上扩展：
// · 公开资料：中文名 / 英文名 / 性别 / 地区（合规显示名）/ 头像完整 URL /
//   军衔（高级时间绝对阈值评定，与站内军衔徽章同口径）/ 最近登录时间；
// · 三级别（初/中/高）双体系最好成绩：time / 3bvs 附达成录像 ID
//   （user_scores(_nf) 口径，与 user_info 完全同构；sum 汇总级无录像 ID）；
// · 各级历史最高 STNB：user_stnb_best(_nf) 落盘表（与 STNB 榜同源），
//   附达成录像 ID 与该盘成绩快照；该级无记录为 null；
// · 全国排行名次：user_rank 落盘表主榜口径（总时间升序），未上榜为 null。
// 隐私一律不出：QQ / 邮箱 / 注册 IP / 登录 IP / 生日等（同 user_info 口径）。
// 封禁用户 token 直接 401（requireUserToken 内置），不会走到资料查询。

import { NextResponse } from "next/server";
import { requireUserToken } from "@/lib/usertoken";
import { prisma } from "@/lib/db";
import { areaDisplay } from "@/lib/config";
import { resolveAvatarUrl } from "@/lib/avatar";
import { title } from "@/lib/assess";
import { getThunderKingThreshold } from "@/lib/title-system";
import { getUserRanks } from "@/lib/queries";

/** user_scores(_nf) 行的成绩列（结构类型，Prisma 行结构兼容） */
interface ScoresRow {
  begTime: number | null; beg3bvs: number | null;
  intTime: number | null; int3bvs: number | null;
  expTime: number | null; exp3bvs: number | null;
  sumTime: number | null; sum3bvs: number | null;
  begTimeVideo: bigint | null; beg3bvsVideo: bigint | null;
  intTimeVideo: bigint | null; int3bvsVideo: bigint | null;
  expTimeVideo: bigint | null; exp3bvsVideo: bigint | null;
}

/** user_stnb_best(_nf) 行（两表同构） */
interface StnbRow {
  level: string;
  stnb: number;
  bestVideo: bigint;
  bestTime: number;
  bestNf: boolean;
}

export async function GET(req: Request) {
  const ident = await requireUserToken(req);
  if (!ident) {
    return NextResponse.json(
      { error: "unauthorized", message: "缺少、无效或已过期的 Bearer token，请重新登录获取" },
      { status: 401 }
    );
  }
  const uid = ident.uid;

  const [user, scores, scoresNf, stnbRows, stnbNfRows, kingTh, ranks] = await Promise.all([
    prisma.user.findUnique({ where: { id: BigInt(uid) } }),
    prisma.userScores.findUnique({ where: { id: BigInt(uid) } }),
    prisma.userScoresNf.findUnique({ where: { id: BigInt(uid) } }),
    prisma.userStnbBest.findMany({ where: { user: BigInt(uid) } }),
    prisma.userStnbBestNf.findMany({ where: { user: BigInt(uid) } }),
    getThunderKingThreshold(),
    getUserRanks(uid),
  ]);
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", message: "用户不存在，请重新登录获取" },
      { status: 401 }
    );
  }

  // 头像 URL：新版上传 /uploads/avatar/… 与 OAuth 外链（http…）原样；
  // 旧站标记位 "1" → 照片墙实体 /images/player/{id}.jpg；其余默认图 no.jpg
  // （与站内 usercard 完全同款解析）。相对路径拼完整域名（SITE_URL 优先，
  // 同 video_info fileUrl 口径），客户端拿到即可直接展示。
  const base = process.env.SITE_URL ?? new URL(req.url).origin;
  const rawAvatar = resolveAvatarUrl(
    user.avatar,
    user.avatar === "1" ? `/images/player/${uid}.jpg` : "/images/player/no.jpg"
  );
  const avatarUrl = /^https?:\/\//.test(rawAvatar) ? rawAvatar : `${base}${rawAvatar}`;

  /** user_scores(_nf) 行 → 双体系成绩（各级 time/3bvs 附录像指针，0=无；sum 无录像） */
  const scoresOf = (s: ScoresRow | null) =>
    s
      ? {
          beg: { time: Number(s.begTime ?? 0), timeVideoId: Number(s.begTimeVideo ?? 0), "3bvs": Number(s.beg3bvs ?? 0), "3bvsVideoId": Number(s.beg3bvsVideo ?? 0) },
          int: { time: Number(s.intTime ?? 0), timeVideoId: Number(s.intTimeVideo ?? 0), "3bvs": Number(s.int3bvs ?? 0), "3bvsVideoId": Number(s.int3bvsVideo ?? 0) },
          exp: { time: Number(s.expTime ?? 0), timeVideoId: Number(s.expTimeVideo ?? 0), "3bvs": Number(s.exp3bvs ?? 0), "3bvsVideoId": Number(s.exp3bvsVideo ?? 0) },
          sum: { time: Number(s.sumTime ?? 0), "3bvs": Number(s.sum3bvs ?? 0) },
        }
      : null;

  /** user_stnb_best(_nf) 行 → 各级历史最高 STNB（与 STNB 榜同源；该级无行=null） */
  const stnbOf = (rows: StnbRow[]) => {
    const out: Record<string, { stnb: number; videoId: number; time: number; nf: boolean } | null> = {
      beg: null, int: null, exp: null,
    };
    for (const r of rows) {
      if (r.level in out) {
        out[r.level] = { stnb: Number(r.stnb), videoId: Number(r.bestVideo), time: Number(r.bestTime), nf: r.bestNf };
      }
    }
    return out;
  };

  return NextResponse.json({
    user: {
      id: uid,
      username: ident.username,
      role: ident.role,
      chineseName: user.chineseName,
      englishName: user.englishName,
      sex: user.sex, // 1=男 0=女
      area: areaDisplay(user.area),
      avatarUrl,
      // 军衔：高级时间绝对阈值评定（总司令=动态阈值档），与站内军衔徽章/军衔页同口径
      militaryTitle: title(scores?.expTime, kingTh),
      // 最近登录时间（Unix 秒；0=未记录）
      lastLoginTime: Number(user.lastLoginTime),
      // 全国主榜名次（总时间升序口径，与个人主页「全国第 X 名」同源）；null=未上榜
      rank: ranks?.national ?? null,
      scores: scoresOf(scores as ScoresRow | null),
      scoresNf: scoresOf(scoresNf as ScoresRow | null),
      stnb: stnbOf(stnbRows),
      stnbNf: stnbOf(stnbNfRows),
    },
  });
}
