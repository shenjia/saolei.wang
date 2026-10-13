// 侧栏个人卡片数据（2026-10-13 六轮定稿，设计稿 design/sidebar-panel.html）
// 卡片结构：照片（点击进主页）｜ 右侧姓名 + 性别图标 + 军衔、其下地区/全国排行（与头像齐平）
//   ｜ 分隔线以下四级纪录（照搬用户主页 ScoreTime / Score3bvs 渲染）+ 最近登录；
//   卡片下方另有「实力」雷达图板块，由页面按 hasVideos 决定是否渲染（与用户主页同规则）。
// 数据来源：getUserDetail（用户 + 成绩 + 录像统计，与用户主页完全同一口径）
//   + getUserRanks（地区/全国名次）+ rank_snapshot（今日升降）。
// 2026-10-13 六轮起卡片不再显示人气，getClicks 查询一并下线。

import { prisma } from "./db";
import { getUserDetail, getUserRanks } from "./queries";
import { resolveAvatarUrl } from "./avatar";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** 单级纪录：成绩原始值（×1000 存储，null=无）、对应录像 id 与日期（sum 级无录像 → null） */
export interface UserCardScore {
  score: number | null;
  videoId: number | null;
  date: number | null;
}

export interface UserCardData {
  id: number;
  chineseName: string;
  sex: number;
  /** 头像 URL（本地 /images/player/{id}.jpg、OAuth 外链或默认 no.jpg） */
  avatarUrl: string;
  /** 军衔（高级时间绝对阈值，与首页/排行榜/军衔页同口径） */
  militaryTitle: string;
  /** 全国名次（ROW_NUMBER 口径，与用户主页「全国第 X 名」、rank_snapshot 同源）；null=未上榜 */
  rank: number | null;
  /** 日升降（正=进步名次数，负=退步，null=昨日无快照即今日新上榜） */
  delta: number | null;
  /** 地区（军区）名；areaPos=null 表示未加入地区排行（无地区/多地区） */
  area: string;
  areaPos: number | null;
  /** 四级成绩（键 `${level}_${order}`，与 getUserDetail 同构，直接喂 ScoreTime / Score3bvs） */
  scores: Record<string, UserCardScore>;
  /** 是否上传过录像（决定是否显示「实力」雷达板块，与用户主页同门槛） */
  hasVideos: boolean;
  /** Unix 秒，0=未记录 */
  lastLoginTime: number;
}

function avatarUrl(id: number, avatar: string): string {
  // 新版上传头像（/uploads/avatar/…）与 OAuth 外链由 resolveAvatarUrl 统一识别；
  // 旧站标记位 "1" 对应照片墙实体，其余用 no.jpg 兜底
  return resolveAvatarUrl(avatar, avatar === "1" ? `/images/player/${id}.jpg` : "/images/player/no.jpg");
}

/**
 * 侧栏个人卡片数据（单用户，2026-10-13 六轮定稿）。
 * 论坛右栏（楼主）与录像详情页右栏（录像作者）共用；楼层内的作者信息走 AvatarCell（不拉卡片），
 * 避免一页 20 楼的额外开销。
 */
export async function getUserCard(id: number): Promise<UserCardData | null> {
  const [detail, ranks, ySnaps] = await Promise.all([
    getUserDetail(id),
    // 地区名次（无地区/多地区玩家 areaPos=null）
    getUserRanks(id),
    prisma.rankSnapshot.findMany({
      where: { user: BigInt(id), date: yesterdayStr() },
      select: { sumTimeRank: true },
    }),
  ]);
  if (!detail) return null;

  const { user, stat } = detail;
  // 名次与升降：全国名次取窗口函数口径（与用户主页一致），升降与 rank_snapshot 同源
  const national = ranks?.national ?? null;
  const yRank = ySnaps.length ? N(ySnaps[0].sumTimeRank) : null;
  const scores: Record<string, UserCardScore> = {};
  for (const [key, rec] of Object.entries(detail.scores)) {
    scores[key] = { score: rec.score, videoId: rec.videoId, date: rec.date };
  }

  return {
    id,
    chineseName: user.chineseName,
    sex: user.sex,
    avatarUrl: avatarUrl(id, user.avatar),
    militaryTitle: detail.title,
    rank: national,
    delta: national !== null ? (yRank !== null ? yRank - national : null) : null,
    area: ranks?.area ?? "",
    areaPos: ranks?.areaPos ?? null,
    scores,
    hasVideos: !!stat && stat.begVideos + stat.intVideos + stat.expVideos > 0,
    lastLoginTime: user.lastLoginTime,
  };
}

/** 顶部导航右侧用户菜单用：只取姓名 + 头像 URL（不拉成绩/名次，避免每页额外开销） */
export async function getHeaderUser(
  uid: number,
): Promise<{ chineseName: string; avatarUrl: string } | null> {
  const u = await prisma.user.findUnique({
    where: { id: BigInt(uid) },
    select: { chineseName: true, avatar: true },
  });
  if (!u) return null;
  return { chineseName: u.chineseName, avatarUrl: avatarUrl(uid, u.avatar) };
}

function yesterdayStr(): string {
  const d = new Date(Date.now() - 86400_000);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
