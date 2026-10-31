// 权威服务负载查询（2026-10-28 张老师需求）：后台练习数据页地图右侧的服务器
// 负载面板数据源，每 3s 由客户端轮询本接口。
// 直接透传各实例开放 /health（server.mjs：connections=在线连接数、active=
// 进行中且有活连接的局数、games=内存局总数、draining=排空中、region/slot）。
// 北京双实例走本机回环（Next 与 authority 同机）；香港走 AUTHORITY_HK_URL
// 公网回调。单实例 override（AUTHORITY_INTERNAL_URL，本地开发）时只列一条。

import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/guard";

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
}

export async function GET() {
  const guard = await requireAdminApi();
  if ("error" in guard) return guard.error;

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
        };
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
        };
      } catch {
        return { name: t.name, region: "", slot: "", ok: false, rtt: 0, connections: 0, active: 0, games: 0, draining: false };
      }
    }),
  );
  // 后台监控轮询，禁任何缓存
  return NextResponse.json({ servers }, { headers: { "Cache-Control": "no-store" } });
}
