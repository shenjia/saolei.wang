// 名次落盘（2026-10-22 张老师定）：user_rank 表存全国名次 + 地区名次。
//
// 背景：getUserRanks 原实现每次全表 ROW_NUMBER 窗口扫（3.5 万行 ×2 CTE，慢日志实证
// 1.1s/次、20 分钟 12 次），是站点常态 CPU 税大头。名次只在下述事件变化，落盘后增量搬位：
//   ① 审核通过新录像（sum_time 变小/首次入伍）→ 出旧位进新位
//   ② 审核屏蔽旧录像（sum_time 变大/掉出榜）→ 出旧位进新位/出榜
//   ③ 上榜用户被封禁 → 出榜；解禁（含限时封禁到期自动解禁）→ 回榜
// 兜底：每日 00:05 rank-snapshot-refresh 全量重建（同步管线整表重写 user_scores 后对齐）；
//       读取侧在榜却缺行时自愈重建（queries.ts getUserRanksImpl）。
//
// 核心不变量：user_rank 恒等于「有效榜单」——user_scores JOIN user
// WHERE sum_time>0 AND status=0 按 (sum_time ASC, id ASC) 的 ROW_NUMBER。
// 平序必须破掉（id 升序），否则 ROW_NUMBER 不可复现、增量位移不成立。
// 位移语义（位次 P）：
//   出榜/前移：P 之后的人 national-1；进榜/后移：>= 新位的人 national+1。地区名次同理（限同 area）。
//
// 事务约定：review.ts 在审核事务内调用（原子）；ops.ts/ban.ts 在主写操作后调用，
// 失败仅记日志不阻断（读取侧自愈兜底）。调用方契约：若用户此前在榜，必须先 leave 再 enter。

import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/** 事务客户端或 PrismaClient 均可（raw 方法结构兼容；union 直调 TS2349，统一 cast） */
type DB = Prisma.TransactionClient;

const asTx = (client: DB | typeof prisma): DB => client as DB;

export interface RankRow {
  national: number;
  area: string;
  areaPos: number | null;
}

// ---------- 全量重建 ----------

let rebuildInflight: Promise<void> | null = null;

/** 全量重建（幂等，35k 行约 1-2s）。并发去重：in-flight 期间复用同一 Promise */
export async function rebuildUserRanks(client: DB | typeof prisma): Promise<void> {
  const tx = asTx(client);
  await tx.$executeRaw`DELETE FROM user_rank`;
  // MySQL 8：WITH 挂在 INSERT...SELECT 的 SELECT 前（PG 式 WITH...INSERT 不支持）
  await tx.$executeRaw`
    INSERT INTO user_rank (id, national, area, area_pos, update_time)
    WITH allr AS (
      SELECT s.id, u.area,
             ROW_NUMBER() OVER (ORDER BY s.sum_time ASC, s.id ASC) npos
      FROM user_scores s JOIN user u ON u.id = s.id
      WHERE s.sum_time > 0 AND u.status = 0
    ),
    arear AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY area ORDER BY npos) apos
      FROM allr
      WHERE area <> '' AND area NOT LIKE '%&%'
    )
    SELECT a.id, a.npos, a.area, b.apos, UNIX_TIMESTAMP()
    FROM allr a LEFT JOIN arear b ON b.id = a.id`;
}

/** 自愈入口（读取侧调用）：并发去重的全量重建 */
export async function rebuildUserRanksOnce(): Promise<void> {
  if (!rebuildInflight) {
    rebuildInflight = rebuildUserRanks(prisma).finally(() => {
      rebuildInflight = null;
    });
  }
  return rebuildInflight;
}

// ---------- 增量搬位 ----------

/** 读某用户当前落盘名次；不在榜（无行）返回 null */
export async function readUserRank(client: DB | typeof prisma, uid: bigint): Promise<RankRow | null> {
  const rows = await asTx(client).$queryRaw<{ national: number; area: string; area_pos: number | null }[]>`
    SELECT national, area, area_pos FROM user_rank WHERE id = ${uid}`;
  if (!rows.length) return null;
  return { national: Number(rows[0].national), area: rows[0].area, areaPos: rows[0].area_pos === null ? null : Number(rows[0].area_pos) };
}

/** 用户离开榜单（封禁/掉出榜）：占位删除，位次在后者整体前移一位 */
export async function rankLeave(client: DB | typeof prisma, uid: bigint): Promise<void> {
  const tx = asTx(client);
  const cur = await readUserRank(tx, uid);
  if (!cur) return; // 本就不在榜（未上榜/已被封/成绩为 0）→ 无事发生
  await tx.$executeRaw`DELETE FROM user_rank WHERE id = ${uid}`;
  await tx.$executeRaw`UPDATE user_rank SET national = national - 1 WHERE national > ${cur.national}`;
  if (cur.areaPos !== null) {
    await tx.$executeRaw`UPDATE user_rank SET area_pos = area_pos - 1 WHERE area = ${cur.area} AND area_pos > ${cur.areaPos}`;
  }
}

/**
 * 用户进入榜单（解禁回榜/首次成绩/成绩变化后重排）：按当前 user_scores 计算新位，
 * 占位并后移他人。用户当前不满足上榜条件（封禁中/sum_time=0）时 no-op——
 * 例如给封禁用户的待审录像过审：user_scores 照常更新，名次等解禁时再算。
 */
export async function rankEnter(client: DB | typeof prisma, uid: bigint): Promise<void> {
  const tx = asTx(client);
  // 上榜条件与全量重建口径完全一致（含 status=0：解禁钩子必须在 user.update 之后调用）
  const rows = await tx.$queryRaw<{ st: number; area: string }[]>`
    SELECT s.sum_time st, u.area
    FROM user_scores s JOIN user u ON u.id = s.id
    WHERE s.id = ${uid} AND s.sum_time > 0 AND u.status = 0`;
  if (!rows.length) return;
  const sumTime = Number(rows[0].st);
  const area = rows[0].area;

  // 新位 = 严格排在前的人数 + 1（平序 (sum_time, id)：同分且 id 更小者在前）
  const natRows = await tx.$queryRaw<{ p: bigint }[]>`
    SELECT COUNT(*) + 1 p
    FROM user_scores s JOIN user u ON u.id = s.id
    WHERE s.sum_time > 0 AND u.status = 0
      AND (s.sum_time < ${sumTime} OR (s.sum_time = ${sumTime} AND s.id < ${uid}))`;
  const national = Number(natRows[0].p);

  // 地区名次：同区按同一平序计数（多地区/空地区不排地区名次，与全量重建口径一致）
  let areaPos: number | null = null;
  if (area !== "" && !area.includes("&")) {
    const aRows = await tx.$queryRaw<{ p: bigint }[]>`
      SELECT COUNT(*) + 1 p
      FROM user_scores s JOIN user u ON u.id = s.id
      WHERE s.sum_time > 0 AND u.status = 0 AND u.area = ${area}
        AND (s.sum_time < ${sumTime} OR (s.sum_time = ${sumTime} AND s.id < ${uid}))`;
    areaPos = Number(aRows[0].p);
    await tx.$executeRaw`UPDATE user_rank SET area_pos = area_pos + 1 WHERE area = ${area} AND area_pos >= ${areaPos}`;
  }

  await tx.$executeRaw`UPDATE user_rank SET national = national + 1 WHERE national >= ${national}`;
  await tx.$executeRaw`
    INSERT INTO user_rank (id, national, area, area_pos, update_time)
    VALUES (${uid}, ${national}, ${area}, ${areaPos}, UNIX_TIMESTAMP())
    ON DUPLICATE KEY UPDATE national = VALUES(national), area = VALUES(area),
      area_pos = VALUES(area_pos), update_time = VALUES(update_time)`;
}

/**
 * 审核路径的成绩变化名次维护（审核通过/屏蔽共用，sum_time 以 flag 榜 user_scores 为准）：
 *   prev>0 且 next>0 且不等 → 出旧位进新位；仅 prev>0 → 出榜；仅 next>0 → 进榜；相等不动。
 * 须在 user_scores 写入的同一事务内、写入之后调用。
 */
export async function applyRankScoreChange(
  client: DB,
  uid: number,
  prevSumTime: number,
  nextSumTime: number
): Promise<void> {
  if (prevSumTime === nextSumTime) return;
  if (prevSumTime > 0) await rankLeave(client, BigInt(uid));
  if (nextSumTime > 0) await rankEnter(client, BigInt(uid));
}

/**
 * 换地区名次维护（2026-10-25 修改资料可更换地区）：在 user.area 写入之后同事务调用。
 * 语义：旧区出位（同区后者前移）→ 新区重算进位（national 不变，名次与成绩无关只随 area 搬）。
 * 全量重建口径一致性：arear 只排 area<>'' 且不含 '&' 的用户——旧区/新区任一是多地区
 * 或空值时，对应侧退化为纯 area 字段更新（无区名次可搬）。
 */
export async function applyRankAreaChange(
  client: DB,
  uid: number,
  prevArea: string,
  nextArea: string
): Promise<void> {
  if (prevArea === nextArea) return;
  const tx = asTx(client);
  const buid = BigInt(uid);
  const cur = await readUserRank(tx, buid);
  if (!cur) return; // 不在榜（无成绩/封禁中）→ user_rank 无行，area 由 user 表自带，无需搬位

  const hasAreaRank = (a: string) => a !== "" && !a.includes("&");
  // 旧区有区名次：同区后者整体前移一位，与本表 area_pos 语义一致
  if (cur.areaPos !== null && hasAreaRank(cur.area)) {
    await tx.$executeRaw`UPDATE user_rank SET area_pos = area_pos - 1 WHERE area = ${cur.area} AND area_pos > ${cur.areaPos}`;
  }
  // 新区有名次资格：严格排在前面的人 +1（平序 (sum_time, id)，与 rankEnter 同口径；
  // 但 national 全榜位次不变，不搬全国位）→ 同区 >= 新位者后移一位
  let nextPos: number | null = null;
  if (hasAreaRank(nextArea)) {
    const rows = await tx.$queryRaw<{ st: bigint }[]>`
      SELECT s.sum_time st FROM user_scores s WHERE s.id = ${buid}`;
    const sumTime = rows.length ? Number(rows[0].st) : 0;
    if (sumTime > 0) {
      const p = await tx.$queryRaw<{ p: bigint }[]>`
        SELECT COUNT(*) + 1 p
        FROM user_scores s JOIN user u ON u.id = s.id
        WHERE s.sum_time > 0 AND u.status = 0 AND u.area = ${nextArea}
          AND (s.sum_time < ${sumTime} OR (s.sum_time = ${sumTime} AND s.id < ${buid}))`;
      nextPos = Number(p[0].p);
      await tx.$executeRaw`UPDATE user_rank SET area_pos = area_pos + 1 WHERE area = ${nextArea} AND area_pos >= ${nextPos}`;
    }
  }
  // 本行：area 换新值；新区无资格（多地区/空）时 area_pos 置 null（与全量重建 arear 过滤一致）
  await tx.$executeRaw`
    UPDATE user_rank SET area = ${nextArea}, area_pos = ${nextPos}, update_time = UNIX_TIMESTAMP()
    WHERE id = ${buid}`;
}

/** 非事务路径（后台封禁/解禁）的安全包装：失败仅记日志，靠读取侧自愈兜底 */
export async function safeRankOp(fn: () => Promise<void>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[userrank] ${label} failed:`, e);
  }
}
