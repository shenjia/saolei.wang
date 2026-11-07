// 权威服务负载查询（2026-10-28 张老师需求）：后台练习数据页地图右侧的服务器
// 负载面板数据源，每 3s 由客户端轮询本接口。
// 直接透传各实例开放 /health（server.mjs：connections=在线连接数、active=
// 进行中且有活连接的局数、games=内存局总数、draining=排空中、region/slot）。
// 北京双实例走本机回环（Next 与 authority 同机）；香港走 AUTHORITY_HK_URL
// 公网回调。单实例 override（AUTHORITY_INTERNAL_URL，本地开发）时只列一条。
// 2026-11-02 张老师需求：负载行可展开在线玩家列表——同轮再透传各实例
// /players（Bearer 鉴权端点，返回 uid/会话名/本实例累计开局面数），本接口
// 查库补齐展示字段（地区/姓名/性别/军衔）。/players 拉取失败该行 players=null。

import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/guard";
import { prisma } from "@/lib/db";
import { title } from "@/lib/assess";
import { getThunderKingThreshold } from "@/lib/title-system";

export const dynamic = "force-dynamic";

interface Target {
  name: string;
  base: string;
  /** 该实例的 Bearer token env 名（与 authority-endpoint.ts 同一套密钥） */
  tokenEnv?: string;
}

function targets(): Target[] {
  const override = process.env.AUTHORITY_INTERNAL_URL;
  if (override) return [{ name: "北京", base: override.replace(/\/$/, "") }];
  const a = process.env.AUTHORITY_PORT_A || "3104";
  const b = process.env.AUTHORITY_PORT_B || "3105";
  const list = [
    { name: "北京1", base: `http://127.0.0.1:${a}`, tokenEnv: "AUTHORITY_HTTP_TOKEN" },
    { name: "北京2", base: `http://127.0.0.1:${b}`, tokenEnv: "AUTHORITY_HTTP_TOKEN" },
  ];
  if (process.env.AUTHORITY_HK_URL) list.push({ name: "香港", base: process.env.AUTHORITY_HK_URL.replace(/\/$/, ""), tokenEnv: "AUTHORITY_HK_TOKEN" });
  if (process.env.AUTHORITY_HZ_URL) list.push({ name: "杭州", base: process.env.AUTHORITY_HZ_URL.replace(/\/$/, ""), tokenEnv: "AUTHORITY_HZ_TOKEN" });
  if (process.env.AUTHORITY_CD_URL) list.push({ name: "成都", base: process.env.AUTHORITY_CD_URL.replace(/\/$/, ""), tokenEnv: "AUTHORITY_CD_TOKEN" });
  if (process.env.AUTHORITY_GZ_URL) list.push({ name: "广州", base: process.env.AUTHORITY_GZ_URL.replace(/\/$/, ""), tokenEnv: "AUTHORITY_GZ_TOKEN" });
  return list;
}

interface Row {
  name: string;
  region: string;
  slot: string;
  ok: boolean;
  rtt: number;
  connections: number;
  active: number;
  games: number;
  draining: boolean;
  /** 今日去重连接人数（server.mjs 北京时间零点清零，重启不清零；旧版实例回退累计值） */
  connsUsers: number;
  /** 今日开局面数（server.mjs 北京时间零点清零，重启不清零；旧版实例回退累计值） */
  gamesServed: number;
  /** 玩家实测平均延迟（ranked_rtt_log 近 7 天按节点聚合，null=无样本） */
  rttAvg: number | null;
  /** 延迟样本数 */
  rttN: number;
  /** 在线玩家（null=/players 拉取失败；[]＝无在线玩家） */
  players: PlayerRow[] | null;
}

/** 在线玩家行（展示字段由本接口查库补齐） */
export interface PlayerRow {
  uid: number;
  /** 展示名：中文名优先，退会话登录名 */
  name: string;
  /** 所属地区（user.area，空串=未填） */
  area: string;
  /** 1=男 0=女 */
  sex: number;
  /** 军衔（按高级时间阈值评定，总司令=雷界第一人特判） */
  rank: string;
  /** 在该实例上的累计开局面数（server.mjs 落盘统计，重启不清零） */
  games: number;
  /** 本轮在线时长（秒，连接建立起算；同 uid 多标签页取最早连接） */
  online: number;
  /** 该玩家在本节点 ranked 局实测平均延迟（ranked_rtt_log 近 7 天，null=无样本） */
  rttAvg: number | null;
  /** 该玩家在本节点的延迟样本数 */
  rttN: number;
}

export async function GET() {
  const guard = await requireAdminApi();
  if ("error" in guard) return guard.error;

  // 玩家实测延迟（2026-11-01 张老师定：面板延迟列不再用后台探测值，改
  // ranked_rtt_log 近 7 天按节点聚合——客户端每秒 WS 探测采样随局上报）。
  // 失败静默：聚合挂了面板延迟列显示 —，不影响健康状态展示
  let rttByRegion = new Map<string, { avg: number; n: number }>();
  try {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = await prisma.$queryRawUnsafe<{ region: string; n: bigint; avg: number }[]>(
      `SELECT region, COUNT(*) n, AVG(rtt) avg FROM ranked_rtt_log
       WHERE create_time >= ? AND rtt > 0 AND region <> '' GROUP BY region`,
      since,
    );
    rttByRegion = new Map(rows.map((r) => [r.region, { avg: Math.round(r.avg), n: Number(r.n) }]));
  } catch { /* ignore */ }

  // 玩家个体延迟（2026-11-02 五次张老师：玩家列表尾列，三色同主表口径）——
  // ranked_rtt_log 近 7 天按 (user_id, region) 聚合；rtt 是排行局结束时上报的
  // 采样，所以是「近期打过的局的实测」，不是实时探针。失败静默显示 —
  let rttByUserRegion = new Map<string, { avg: number; n: number }>();
  try {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = await prisma.$queryRawUnsafe<{ user_id: bigint; region: string; n: bigint; avg: number }[]>(
      `SELECT user_id, region, COUNT(*) n, AVG(rtt) avg FROM ranked_rtt_log
       WHERE create_time >= ? AND rtt > 0 AND region <> '' GROUP BY user_id, region`,
      since,
    );
    rttByUserRegion = new Map(rows.map((r) => [`${r.user_id}:${r.region}`, { avg: Math.round(r.avg), n: Number(r.n) }]));
  } catch { /* ignore */ }

  // 先拉各实例 /health + /players，再对去重 uid 集合一次查库补齐展示字段。
  // loginNames=各实例会话登录名兜底（user 行被删等异常时姓名不至于空）
  const loginNames = new Map<number, string>();
  const fetched = await Promise.all(
    targets().map(async (t) => {
      const t0 = Date.now();
      const headers: Record<string, string> = {};
      const token = t.tokenEnv ? process.env[t.tokenEnv] : undefined;
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        const res = await fetch(`${t.base}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
        const j = (await res.json()) as {
          region?: string;
          slot?: string;
          connections?: number;
          active?: number;
          games?: number;
          draining?: boolean;
          connsUsers?: number;
          gamesServed?: number;
          todayConnsUsers?: number;
          todayGamesServed?: number;
        };
        // 上报 region 键＝gameId 首段：北京（REGION 空串）走槽位 a/b，其他地域走 region
        const rkey = j.region || j.slot || "";
        let players: PlayerRow[] | null = null;
        try {
          const pres = await fetch(`${t.base}/players`, { cache: "no-store", headers, signal: AbortSignal.timeout(2000) });
          if (pres.ok) {
            const pj = (await pres.json()) as { players?: { uid: number; name?: string; games?: number; secs?: number }[] };
            players = (pj.players ?? []).map((p): PlayerRow => {
              const uid = Number(p.uid);
              if (typeof p.name === "string" && p.name) loginNames.set(uid, p.name);
              const rtt = rttByUserRegion.get(`${uid}:${rkey}`) ?? null;
              return { uid, name: "", area: "", sex: 1, rank: "预备役", games: Number(p.games) || 0, online: Math.max(0, Number(p.secs) || 0), rttAvg: rtt?.avg ?? null, rttN: rtt?.n ?? 0 };
            });
          }
        } catch { /* players 拉取失败：该行显示获取失败，不影响负载展示 */ }
        const row: Row = {
          name: t.name,
          region: j.region ?? "",
          slot: j.slot ?? "",
          ok: res.ok,
          rtt: Date.now() - t0,
          connections: j.connections ?? 0,
          active: j.active ?? 0,
          games: j.games ?? 0,
          draining: Boolean(j.draining),
          /* 灰色数字仅限今天（2026-11-08 张老师需求）：优先取实例今日值，
             旧版实例（未重启、无 today 字段）回退累计值，避免显示 0 */
          connsUsers: j.todayConnsUsers ?? j.connsUsers ?? 0,
          gamesServed: j.todayGamesServed ?? j.gamesServed ?? 0,
          rttAvg: rttByRegion.get(rkey)?.avg ?? null,
          rttN: rttByRegion.get(rkey)?.n ?? 0,
          players,
        };
        return row;
      } catch {
        const row: Row = { name: t.name, region: "", slot: "", ok: false, rtt: 0, connections: 0, active: 0, games: 0, draining: false, connsUsers: 0, gamesServed: 0, rttAvg: null, rttN: 0, players: null };
        return row;
      }
    }),
  );

  // 查库补齐玩家展示字段：地区/姓名/性别 + 军衔（高级时间阈值 + 雷界第一人特判）
  const allUids = [...new Set(fetched.flatMap((r) => (r.players ?? []).map((p) => p.uid)))].filter((n) => Number.isInteger(n) && n > 0);
  if (allUids.length) {
    const [users, scores, kingId] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: allUids.map(BigInt) } },
        select: { id: true, chineseName: true, englishName: true, sex: true, area: true },
      }),
      prisma.userScores.findMany({
        where: { id: { in: allUids.map(BigInt) } },
        select: { id: true, expTime: true },
      }),
      getThunderKingThreshold().catch(() => 0),
    ]);
    const uMap = new Map(users.map((u) => [Number(u.id), u]));
    const eMap = new Map(scores.map((s) => [Number(s.id), s.expTime ?? 0]));
    for (const row of fetched) {
      if (!row.players) continue;
      for (const p of row.players) {
        const u = uMap.get(p.uid);
        p.name = u?.chineseName || u?.englishName || loginNames.get(p.uid) || `#${p.uid}`;
        p.area = u?.area ?? "";
        p.sex = u?.sex ?? 1;
        p.rank = title(eMap.get(p.uid) ?? 0, kingId);
      }
      row.players.sort((a, b) => b.games - a.games || a.uid - b.uid); // 对局多在前
    }
  }

  // 后台监控轮询，禁任何缓存
  return NextResponse.json({ servers: fetched }, { headers: { "Cache-Control": "no-store" } });
}
