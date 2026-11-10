import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";

/** 开源扫雷网绑定关系与同步表态（openms_link 表，2026-11-07） */

/** 同步征求截止时刻：2026-11-14 00:00:00 +08:00（11-13 全天仍可表态，过后不再提醒） */
export const OPENMS_CONSENT_DEADLINE = 1794585600;

/** 开源扫雷网基址（绑定协议 v2 的授权页与状态查询 API 都在其下）。
 * dev 联调 mock：touch /tmp/saolei-openms-mock 后重启 dev，指向 scripts/mock-openms.mjs（3100 环境专用，生产不设此 env 不受影响） */
export const OPENMS_BASE = process.env.OPENMS_BASE_MOCK || "https://openms.top";
/** 开源扫雷网授权页路径（确认雷网发起的申请；其 SPA 为 hash 路由，契约见 docs/partner-api-openms.md） */
export const OPENMS_AUTH_PAGE = `${OPENMS_BASE}/#/bind/saolei`;

export type OpenmsConsent = 0 | 1 | 2; // 0=未表态 1=同意 2=不同意

/** 绑定申请状态（openms_bind_request.status） */
export const OPENMS_BIND_PENDING = 0; // 待对方站确认
export const OPENMS_BIND_DONE = 1; // 已核销（绑定完成）
export const OPENMS_BIND_CANCELLED = 2; // 已取消（被新申请顶掉/用户放弃）

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

/** 绑定后调整同步开关（授权页的开关区；consentOn=false 折算为不同意）。
 * 「扫雷网→开源网」的开关在开源扫雷网侧（其 AccountSaolei.auto_sync），本站不存。 */
export async function setOpenmsPrefs(uid: number, consentOn: boolean): Promise<boolean> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const row = await prisma.openmsLink.updateMany({
    where: { user: BigInt(uid) },
    data: {
      consent: consentOn ? 1 : 2,
      consentTime: now,
      updateTime: now,
    },
  });
  return row.count > 0;
}

// ---------- 绑定协议 v2（2026-11-09：跳转确认+回来核销，无服务端互调） ----------
// 雷网发起：账户设置 → 授权页勾开关生成 token → 跳开源扫雷网授权页确认 → 回雷网核销。
// 开源扫雷网发起：开源扫雷网生成 token → 跳雷网授权页登录确认 → 直接写 openms_link。
// 开关各站落点（2026-11-09 张老师定，默认勾选）：「开源网→扫雷网」在雷网（openms_link.consent），
// 「扫雷网→开源网」在开源扫雷网（其 AccountSaolei.auto_sync，默认 True）——本站的 sync_to_openms 列
// 仅作历史保留，不再写入。协议契约文档：docs/partner-api-openms.md

/** 发起绑定申请：顶掉同用户旧的待确认申请，返回新 token */
export async function createBindRequest(uid: number, consentOn: boolean): Promise<string> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.openmsBindRequest.updateMany({
    where: { user: BigInt(uid), status: OPENMS_BIND_PENDING },
    data: { status: OPENMS_BIND_CANCELLED, updateTime: now },
  });
  const token = randomBytes(24).toString("hex"); // 48 字符，一次性
  await prisma.openmsBindRequest.create({
    data: {
      user: BigInt(uid),
      token,
      consent: consentOn ? 1 : 0,
      status: OPENMS_BIND_PENDING,
      createTime: now,
      updateTime: now,
    },
  });
  return token;
}

/** 查待确认申请（公开 API / 开源扫雷网授权页展示申请者用） */
export async function getPendingBindRequest(token: string) {
  return prisma.openmsBindRequest.findUnique({
    where: { token },
    select: { user: true, token: true, status: true, consent: true },
  });
}

/** 核销：把申请落成绑定关系（profile 由开源扫雷网 API 回填） */
async function settleBindRequest(
  req_: { user: bigint; consent: number },
  profile: number
): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const uid = req_.user;
  // profile 唯一性：已被其他雷网用户占用则拒绝
  const taken = await prisma.openmsLink.findFirst({
    where: { profile, user: { not: uid } },
    select: { user: true },
  });
  if (taken) throw new OpenmsBindError("profile_taken");
  await prisma.$transaction([
    // upsert 绑定关系：已绑同 profile 则刷新开关（consent 折算 1/2），否则插入
    prisma.openmsLink.upsert({
      where: { user: uid },
      create: {
        user: uid,
        profile,
        consent: req_.consent ? 1 : 2,
        consentTime: now,
        createTime: now,
        updateTime: now,
      },
      update: {
        profile,
        consent: req_.consent ? 1 : 2,
        consentTime: now,
        updateTime: now,
      },
    }),
    prisma.openmsBindRequest.updateMany({
      where: { user: uid, status: OPENMS_BIND_PENDING },
      data: { status: OPENMS_BIND_DONE, profile, updateTime: now },
    }),
  ]);
}

/** 绑定流程业务错误（页面据此出友好提示） */
export class OpenmsBindError extends Error {
  constructor(public code: "not_found" | "not_pending" | "openms_api" | "openms_not_confirmed" | "profile_taken") {
    super(code);
  }
}

/** 雷网发起申请的核销：查开源扫雷网状态 API，confirmed 则落绑定。
 * 只允许申请者本人核销（发起页轮询走的是本人会话，防第三方拿 token 代核销） */
export async function settleBindByToken(token: string, uid: number): Promise<{ profile: number }> {
  const reqRow = await prisma.openmsBindRequest.findUnique({
    where: { token },
    select: { user: true, consent: true, status: true },
  });
  if (!reqRow || reqRow.user !== BigInt(uid)) throw new OpenmsBindError("not_found");
  if (reqRow.status !== OPENMS_BIND_PENDING) throw new OpenmsBindError("not_pending");

  // 开源扫雷网契约：GET /api/accountlink/saolei/bind/status?token=… → { profile: number | null, status: "confirmed" | "pending" }
  const info = await openmsApi<{ profile: number; status: string }>(
    `/api/accountlink/saolei/bind/status?token=${encodeURIComponent(token)}`
  );
  if (info.status !== "confirmed") throw new OpenmsBindError("openms_not_confirmed");
  if (!Number.isInteger(info.profile) || info.profile <= 0) throw new OpenmsBindError("openms_api");
  await settleBindRequest(reqRow, info.profile);
  return { profile: info.profile };
}

/** 开源扫雷网发起申请（雷网授权页确认模式）：查开源扫雷网申请信息 API 核验 token */
export async function verifyOpenmsRequest(token: string): Promise<{ profile: number; username: string }> {
  // 开源扫雷网契约：GET /api/accountlink/saolei/bind/request?token=… → { profile: number, username: string, status: "pending" }
  const info = await openmsApi<{ profile: number; username: string; status: string }>(
    `/api/accountlink/saolei/bind/request?token=${encodeURIComponent(token)}`
  );
  if (info.status !== "pending") throw new OpenmsBindError("openms_not_confirmed");
  if (!Number.isInteger(info.profile) || info.profile <= 0) throw new OpenmsBindError("openms_api");
  return { profile: info.profile, username: info.username };
}

/** 开源扫雷网发起申请的确认（雷网授权页点确认）：核验后直接落绑定 */
export async function confirmOpenmsRequest(
  uid: number,
  token: string,
  consentOn: boolean
): Promise<{ profile: number }> {
  const info = await verifyOpenmsRequest(token);
  await settleBindRequest(
    { user: BigInt(uid), consent: consentOn ? 1 : 0 },
    info.profile
  );
  return { profile: info.profile };
}

/** 开源扫雷网 API 调用封装（10s 超时；非 2xx/解析失败统一抛 openms_api） */
async function openmsApi<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${OPENMS_BASE}${path}`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new OpenmsBindError("openms_api");
  }
  if (!res.ok) throw new OpenmsBindError("openms_api");
  try {
    return (await res.json()) as T;
  } catch {
    throw new OpenmsBindError("openms_api");
  }
}
