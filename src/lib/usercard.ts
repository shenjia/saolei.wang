// 个人信息卡片数据（2026-09-23 张老师要求，参照旧版右上角卡片截图）：
// 头像 + 姓名(Id) + 旧版称号GG/mm + 全国名次(日升降) + 四级纪录 + 最近登录 + 进入我的地盘
// 首页登录后替换「每日一星」版块；BBS 每楼正文右侧显示作者卡片

import { prisma } from "./db";
import { usersByIds } from "./queries";
import { oldTitle, type OldTitle } from "./oldtitle";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export interface UserCardScore {
  /** 毫秒，0=无成绩 */
  time: number;
  /** ×1000，0=无成绩 */
  bvs: number;
}

export interface UserCardData {
  id: number;
  chineseName: string;
  sex: number;
  /** 头像 URL（本地 /images/player/{id}.jpg、OAuth 外链或默认 no.jpg） */
  avatarUrl: string;
  /** 旧版称号（雷帝/雷圣/状元…按高级纪录+性别） */
  title: OldTitle;
  /** 全国排名（sum_time 总榜名次，null=未上榜） */
  rank: number | null;
  /** 日升降（正=进步名次数，null=今日新上榜） */
  delta: number | null;
  beg: UserCardScore;
  int: UserCardScore;
  exp: UserCardScore;
  sum: UserCardScore;
  /** Unix 秒，0=未记录 */
  lastLoginTime: number;
}

function avatarUrl(id: number, avatar: string): string {
  if (avatar.startsWith("http")) return avatar; // 微信/QQ OAuth 外链头像
  if (avatar === "1") return `/images/player/${id}.jpg`; // 旧站迁移的实体照片
  return "/images/player/no.jpg";
}

/** 批量取卡片数据（BBS 一页多楼层复用；首页单人也走这里） */
export async function getUserCards(ids: number[]): Promise<Map<number, UserCardData>> {
  const out = new Map<number, UserCardData>();
  const uniq = [...new Set(ids)].filter((x) => x > 0);
  if (!uniq.length) return out;

  // 全国名次实时算（快照是日粒度，当天新破纪录的玩家快照里还没有）；升降=昨日快照名次−当前名次
  const [briefs, scores, users, ranks, ySnaps] = await Promise.all([
    usersByIds(uniq),
    prisma.userScores.findMany({ where: { id: { in: uniq.map(BigInt) } } }),
    prisma.user.findMany({
      where: { id: { in: uniq.map(BigInt) } },
      select: { id: true, avatar: true, lastLoginTime: true },
    }),
    prisma.$queryRawUnsafe<{ id: bigint; r: number }[]>(
      `SELECT s.id, (SELECT COUNT(*) FROM user_scores t WHERE t.sum_time > 0 AND t.sum_time < s.sum_time) + 1 r
       FROM user_scores s WHERE s.sum_time > 0 AND s.id IN (${uniq.map(Number).join(",")})`
    ),
    prisma.rankSnapshot.findMany({
      where: { user: { in: uniq.map(BigInt) }, date: yesterdayStr() },
      select: { user: true, sumTimeRank: true },
    }),
  ]);
  const scoreMap = new Map(scores.map((s) => [N(s.id), s]));
  const userMap = new Map(users.map((u) => [N(u.id), u]));
  // COUNT(*) 在 MySQL 返回 BIGINT：r 运行时实为 BigInt，必须转 number（否则 API JSON 序列化炸）
  const rankMap = new Map(ranks.map((r) => [N(r.id), N(r.r)]));
  const yMap = new Map(ySnaps.map((s) => [N(s.user), s.sumTimeRank]));

  for (const [id, b] of briefs) {
    const sc = scoreMap.get(id);
    const u = userMap.get(id);
    const rank = rankMap.get(id) ?? null;
    const yRank = yMap.get(id);
    out.set(id, {
      id,
      chineseName: b.chineseName,
      sex: b.sex,
      avatarUrl: avatarUrl(id, u?.avatar ?? ""),
      // 雷帝 = 全国第一名（与排行榜称号口径一致）
      title: oldTitle(N(sc?.expTime), b.sex, rank === 1),
      rank,
      delta: rank !== null ? (yRank ? yRank - rank : null) : null,
      beg: { time: N(sc?.begTime), bvs: N(sc?.beg3bvs) },
      int: { time: N(sc?.intTime), bvs: N(sc?.int3bvs) },
      exp: { time: N(sc?.expTime), bvs: N(sc?.exp3bvs) },
      sum: { time: N(sc?.sumTime), bvs: N(sc?.sum3bvs) },
      lastLoginTime: N(u?.lastLoginTime),
    });
  }
  return out;
}

export async function getUserCard(id: number): Promise<UserCardData | null> {
  const cards = await getUserCards([id]);
  return cards.get(id) ?? null;
}

function yesterdayStr(): string {
  const d = new Date(Date.now() - 86400_000);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
