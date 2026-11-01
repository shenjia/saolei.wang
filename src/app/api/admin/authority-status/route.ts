// 权威服务负载查询（2026-10-28 张老师需求）：后台练习数据页地图右侧的服务器
// 负载面板数据源，每 3s 由客户端轮询本接口。
// 直接透传各实例开放 /health（server.mjs：connections=在线连接数、active=
// 进行中且有活连接的局数、games=内存局总数、draining=排空中、region/slot）。
// 北京双实例走本机回环（Next 与 authority 同机）；香港走 AUTHORITY_HK_URL
// 公网回调。单实例 override（AUTHORITY_INTERNAL_URL，本地开发）时只列一条。

import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/guard";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

interface Target {
  name: string;
  url: string;
}

function targets(): Target[] {
  const override = process.env.AUTHORITY_INTERNAL_URL;
  if (override) return [{ name: "北京", url: `${override.replace(/\/$/, "")}/health` }];
  const a = process.env.AUTHORITY_PORT_A || "3104";
  const b = process.env.AUTHORITY_PORT_B || "3105";
  const list = [
    { name: "北京1", url: `http://127.0.0.1:${a}/health` },
    { name: "北京2", url: `http://127.0.0.1:${b}/health` },
  ];
  const hk = process.env.AUTHORITY_HK_URL;
  if (hk) list.push({ name: "香港", url: `${hk.replace(/\/$/, "")}/health` });
  const hz = process.env.AUTHORITY_HZ_URL;
  if (hz) list.push({ name: "杭州", url: `${hz.replace(/\/$/, "")}/health` });
  const cd = process.env.AUTHORITY_CD_URL;
  if (cd) list.push({ name: "成都", url: `${cd.replace(/\/$/, "")}/health` });
  const gz = process.env.AUTHORITY_GZ_URL;
  if (gz) list.push({ name: "广州", url: `${gz.replace(/\/$/, "")}/health` });
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
  /** 累计去重连接人数（server.mjs 内存累计+落盘持久化，重启不清零） */
  connsUsers: number;
  /** 累计开局面数（server.mjs 内存累计+落盘持久化，重启不清零） */
  gamesServed: number;
  /** 玩家实测平均延迟（ranked_rtt_log 近 7 天按节点聚合，null=无样本） */
  rttAvg: number | null;
  /** 延迟样本数 */
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

  const servers = await Promise.all(
    targets().map(async (t): Promise<Row> => {
      const t0 = Date.now();
      try {
        const res = await fetch(t.url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
        const j = (await res.json()) as {
          region?: string;
          slot?: string;
          connections?: number;
          active?: number;
          games?: number;
          draining?: boolean;
          connsUsers?: number;
          gamesServed?: number;
        };
        // 上报 region 键＝gameId 首段：北京（REGION 空串）走槽位 a/b，其他地域走 region
        const rkey = j.region || j.slot || "";
        return {
          name: t.name,
          region: j.region ?? "",
          slot: j.slot ?? "",
          ok: res.ok,
          rtt: Date.now() - t0,
          connections: j.connections ?? 0,
          active: j.active ?? 0,
          games: j.games ?? 0,
          draining: Boolean(j.draining),
          connsUsers: j.connsUsers ?? 0,
          gamesServed: j.gamesServed ?? 0,
          rttAvg: rttByRegion.get(rkey)?.avg ?? null,
          rttN: rttByRegion.get(rkey)?.n ?? 0,
        };
      } catch {
        return { name: t.name, region: "", slot: "", ok: false, rtt: 0, connections: 0, active: 0, games: 0, draining: false, connsUsers: 0, gamesServed: 0, rttAvg: null, rttN: 0 };
      }
    }),
  );
  // 后台监控轮询，禁任何缓存
  return NextResponse.json({ servers }, { headers: { "Cache-Control": "no-store" } });
}
