import { prisma } from "@/lib/db";

/** 开源扫雷网绑定关系与同步表态（openms_link 表，2026-11-07） */

/** 同步征求截止时刻：2026-11-14 00:00:00 +08:00（11-13 全天仍可表态，过后不再提醒） */
export const OPENMS_CONSENT_DEADLINE = 1794585600;

export type OpenmsConsent = 0 | 1 | 2; // 0=未表态 1=同意 2=不同意

export interface OpenmsLinkRow {
  user: bigint;
  profile: number;
  consent: OpenmsConsent;
}

/** 查某用户的绑定与表态（无绑定返回 null） */
export async function getOpenmsLink(uid: number): Promise<OpenmsLinkRow | null> {
  const row = await prisma.openmsLink.findUnique({
    where: { user: BigInt(uid) },
    select: { user: true, profile: true, consent: true },
  });
  if (!row) return null;
  return { user: row.user, profile: row.profile, consent: row.consent as OpenmsConsent };
}

/** 记录表态（仅已绑定用户；重复表态覆盖——以最后一次为准） */
export async function setOpenmsConsent(
  uid: number,
  consent: Exclude<OpenmsConsent, 0>
): Promise<boolean> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const row = await prisma.openmsLink.updateMany({
    where: { user: BigInt(uid) },
    data: { consent, consentTime: now, updateTime: now },
  });
  return row.count > 0;
}
