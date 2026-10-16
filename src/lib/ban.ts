// 限时封禁与自动解禁（2026-10-16 张老师要求）
//
// 口径：
// · user.ban_until —— Unix 秒（与全站时间列同口径），仅 status=-1 时有意义；0 = 永久封禁。
// · 到期自动解禁不靠定时任务，靠「节流清扫」兜底：getSession（每页必经，60s 节流）、
//   登录拦截、榜单黑名单（fetchBannedUserIds，60s 缓存）三处触发，到期 1 分钟内全站生效。
// · 连坐录像：封禁时勾选「同步封禁录像」→ video.status 10/20 改 0 且 status_bak 记原值；
//   解禁（手动或到期）时按 status_bak 精确恢复并清零；被单独屏蔽的录像 status_bak=0 不动。
//   （2026-10-16 张老师拍板：解禁时连坐录像自动恢复）

import { prisma } from "./db";
import { BAN_DURATIONS } from "./config";

const nowSec = () => Math.floor(Date.now() / 1000);

/** 时长 key → ban_until（Unix 秒）；非法 key 返回 null */
export function banUntilFromKey(key: string): number | null {
  const hit = BAN_DURATIONS.find(([k]) => k === key);
  if (!hit) return null;
  return hit[2] === 0 ? 0 : nowSec() + hit[2];
}

export function banDurationLabel(key: string): string {
  return BAN_DURATIONS.find(([k]) => k === key)?.[1] ?? key;
}

/**
 * 解除某账号封禁并恢复连坐录像（手动解封与到期清扫共用）。
 * 返回恢复的录像部数。
 */
export async function unbanUser(uid: number | bigint): Promise<number> {
  const id = BigInt(uid);
  const ts = BigInt(nowSec());
  const restored = await prisma.$executeRaw`
    UPDATE video SET status = status_bak, status_bak = 0, update_time = ${ts}
    WHERE user = ${id} AND status = 0 AND status_bak <> 0`;
  await prisma.user.update({
    where: { id },
    data: { status: 0, banUntil: BigInt(0), updateTime: ts },
  });
  return Number(restored);
}

/** 清扫全部到期的限时封禁（返回解禁人数）；永久封禁（ban_until=0）不受影响 */
export async function liftExpiredBans(): Promise<number> {
  const ts = BigInt(nowSec());
  const expired = await prisma.user.findMany({
    where: { status: -1, banUntil: { gt: BigInt(0), lte: ts } },
    select: { id: true },
  });
  for (const u of expired) await unbanUser(u.id);
  return expired.length;
}

// 节流：60 秒最多清扫一次（getSession 每页都走，不能每次都查库）
let lastSweep = 0;

/** 节流版清扫：供 getSession 等高频路径兜底调用；失败不阻断请求 */
export async function ensureBansLifted(): Promise<void> {
  const t = nowSec();
  if (t - lastSweep < 60) return;
  lastSweep = t;
  try {
    await liftExpiredBans();
  } catch {
    /* 清扫失败不阻断正常请求，下一分钟再试 */
  }
}
