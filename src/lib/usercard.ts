// 侧栏个人卡片数据（2026-10-13 六轮定稿，设计稿 design/sidebar-panel.html）
// 卡片结构：照片（点击进主页）｜ 右侧姓名 + 性别图标 + 军衔、其下地区/全国排行（与头像齐平）
//   ｜ 分隔线以下四级纪录（照搬用户主页 ScoreTime / Score3bvs 渲染）；
//   2026-10-14 张老师要求：卡片不再显示排行升降（delta 字段与 rank_snapshot 查询一并下线）。
//   2026-10-21 张老师要求：恢复最近登录行（lastLoginTime 重新上线，卡片底部绝对日期显示）。
//   卡片下方另有「实力」雷达图板块，由页面按 hasVideos 决定是否渲染（与用户主页同规则）。
// 数据来源：getUserDetail（用户 + 成绩 + 录像统计，与用户主页完全同一口径）
//   + getUserRanks（地区/全国名次）。
// 2026-10-13 六轮起卡片不再显示人气，getClicks 查询一并下线。

import { prisma } from "./db";
import { getUserDetail, getUserRanks } from "./queries";
import { resolveAvatarUrl } from "./avatar";
import { resolveTitleDisplay } from "./title-system";

/** 单级纪录：成绩原始值（×1000 存储，null=无）、对应录像 id 与日期（sum 级无录像 → null） */
export interface UserCardScore {
  score: number | null;
  videoId: number | null;
  date: number | null;
}

export interface UserCardData {
  id: number;
  chineseName: string;
  /** 英文名（hover 气泡「姓名（英文名）#ID」用，2026-10-29） */
  englishName: string;
  sex: number;
  /** 头像 URL（本地 /images/player/{id}.jpg、OAuth 外链或默认 no.jpg） */
  avatarUrl: string;
  /** 军衔（高级时间绝对阈值，与首页/排行榜/军衔页同口径） */
  militaryTitle: string;
  /** Phase 5：旧版称号备选（按当前成绩+在榜状态评定） */
  classicTitle: { name: string; color: string } | null;
  /** 全国名次（ROW_NUMBER 口径，与用户主页「全国第 X 名」同源）；null=未上榜 */
  rank: number | null;
  /** 地区（军区）名；areaPos=null 表示未加入地区排行（无地区/多地区） */
  area: string;
  areaPos: number | null;
  /** 四级成绩（键 `${level}_${order}`，与 getUserDetail 同构，直接喂 ScoreTime / Score3bvs） */
  scores: Record<string, UserCardScore>;
  /** 最近登录时间（Unix 秒；0=从未登录，卡片底部「最近登录」行显示用，2026-10-21 恢复） */
  lastLoginTime: number;
  /** 是否上传过录像（决定是否显示「实力」雷达板块，与用户主页同门槛） */
  hasVideos: boolean;
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
  const [detail, ranks] = await Promise.all([
    getUserDetail(id),
    // 地区名次（无地区/多地区玩家 areaPos=null）
    getUserRanks(id),
  ]);
  if (!detail) return null;

  const { user, stat } = detail;
  const national = ranks?.national ?? null;
  // area 兜底 user 表：无成绩玩家 getUserRanks 返回 null（allr 只含有成绩者），
  // 海外识别不能只依赖 ranks.area，否则无成绩外国人会漏标（2026-10-15）
  const area = ranks?.area ?? user.area;
  const scores: Record<string, UserCardScore> = {};
  for (const [key, rec] of Object.entries(detail.scores)) {
    scores[key] = { score: rec.score, videoId: rec.videoId, date: rec.date };
  }

  // Phase 5：旧版称号备选（当前成绩评定；在榜=user.status===0 且有高级成绩）
  const expMs = detail.scores.exp_time?.score ?? 0;
  const classicPair = await resolveTitleDisplay("c", expMs, user.status === 0 && expMs > 0, user.sex, id);

  return {
    id,
    chineseName: user.chineseName,
    englishName: user.englishName,
    sex: user.sex,
    avatarUrl: avatarUrl(id, user.avatar),
    militaryTitle: detail.title,
    classicTitle: classicPair.system === "c" ? { name: classicPair.name, color: classicPair.color ?? "#666666" } : null,
    rank: national,
    area,
    areaPos: ranks?.areaPos ?? null,
    scores,
    lastLoginTime: detail.user.lastLoginTime,
    hasVideos: !!stat && stat.begVideos + stat.intVideos + stat.expVideos > 0,
  };
}

/** 顶部导航右侧用户菜单用：只取姓名 + 英文名 + 头像 URL（不拉成绩/名次，避免每页额外开销） */
export async function getHeaderUser(
  uid: number,
): Promise<{ chineseName: string; englishName: string; avatarUrl: string } | null> {
  const u = await prisma.user.findUnique({
    where: { id: BigInt(uid) },
    select: { chineseName: true, englishName: true, avatar: true },
  });
  if (!u) return null;
  return { chineseName: u.chineseName, englishName: u.englishName, avatarUrl: avatarUrl(uid, u.avatar) };
}
