// 后台流量统计（2026-10-16 仪表盘 UV/PV，参考 01xue.com /api/admin/stats/overview）
//
// 口径约定（与 stats.ts 一致）：
// · page_view.create_time 为 Unix 秒；「按天」聚合一律 +08:00 切天（FLOOR((t+28800)/86400)），
//   不依赖服务器时区。
// · PV = page_view 行数（排除 isAdmin）；UV = 按日去重 visitorId。
// · 30 天流水一次拉全量内存聚合（个人站量级，上线初期即全量）。
// · 整个聚合挂 unstable_cache 300s（铁律：热点统计必须挂缓存；改查询逻辑必须升版本号）。

import { prisma } from "@/lib/db";
import { unstable_cache } from "next/cache";
import { dayStart } from "@/lib/admin/stats";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// ---------- 类型 ----------

export interface TrafficHit {
  label: string;
  path: string;
  /** 录像级别（beg/int/exp，metaFor 补齐） */
  level: string;
  pv: number;
  uv: number;
}

export interface ExitPage {
  path: string;
  pv: number;
  exits: number;
  /** 退出率（0-1）；PV < 5 不入榜，避免小样本噪声 */
  exitRate: number;
  /** 有停留数据的退出数（覆盖率 = covered/exits） */
  covered: number;
  /** 中位停留毫秒（null = 无样本） */
  medianMs: number | null;
  /** 中位滚动深度 0-100 */
  medianScrollPct: number | null;
  /** 无交互占比（有停留样本中 clicked=false 的比例，%） */
  noClickPct: number | null;
  /** 流失诊断 */
  diagnosis: { type: DiagnosisType; label: string; hint: string };
}

export type DiagnosisType = "bounce" | "shallow" | "read_leave" | "normal" | "collecting";

const DIAGNOSIS: Record<DiagnosisType, { label: string; hint: string }> = {
  bounce: { label: "秒退为主", hint: "≥半数访客 10 秒内离开 → 查首屏/标题与流量来源是否匹配" },
  shallow: { label: "浅读离开", hint: "滚动深度低 → 核心内容没被看到，精简首屏、关键信息前置" },
  read_leave: { label: "看完即走", hint: "读完且无点击 → 内容 OK 但缺下一步，强化导流" },
  normal: { label: "阅读后离开", hint: "停留与滚动正常，属内容页自然行为" },
  collecting: { label: "数据积累中", hint: "停留埋点覆盖不足，需几天积累后才能诊断" },
};

export interface TrafficOverview {
  /** 取数时刻（Unix 秒） */
  now: number;
  today: { pv: number; uv: number };
  yesterday: { pv: number; uv: number };
  d30: { pv: number; uv: number };
  /** 近 30 天分日趋势（+08:00 切天，与业务趋势同 x 轴） */
  trend: { dates: string[]; pv: number[]; uv: number[] };
  /** 近 30 天入口来源 Top（外站域名 + direct，不含 internal） */
  referrers: { source: string; visits: number }[];
  /** 落地页 Top（会话首条 PV 且来源非站内；/video/:id 归类过滤 ID；三档） */
  entryPages: { today: { path: string; entries: number }[]; d7: { path: string; entries: number }[]; d30: { path: string; entries: number }[] };
  /** 近 30 天设备分布 */
  devices: { uaClass: string; pv: number }[];
  /** 高流失页（会话末页占该页 PV 比；录像详情页看完即走正常，排除；三档） */
  exits: { today: ExitPage[]; d7: ExitPage[]; d30: ExitPage[] };
  /** 热门录像页（/video/:id 三档 Top 10，带玩家名/级别） */
  topVideos: { today: TrafficHit[]; d7: TrafficHit[]; d30: TrafficHit[] };
}

// ---------- 工具 ----------

/** /video/123 → /video/:id（落地页/流失聚合过滤自增 ID） */
const VIDEO_RE = /^\/video\/(\d+)$/;
const normalizePath = (p: string): string => p.replace(VIDEO_RE, "/video/:id");

const DEVICE_NAMES: Record<string, string> = {
  desktop: "桌面端",
  mobile: "手机",
  tablet: "平板",
  bot: "爬虫",
  unknown: "未知",
};

const REFERRER_NAMES: Record<string, string> = {
  direct: "直接访问",
  internal: "站内跳转",
};

const median = (nums: number[]): number | null => {
  if (nums.length === 0) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

// ---------- 聚合主体 ----------

async function aggregate(): Promise<TrafficOverview> {
  const now = Math.floor(Date.now() / 1000);
  const today0 = dayStart(0);
  const yesterday0 = dayStart(1);
  const d7 = dayStart(6);
  const d30 = dayStart(29);

  // 管理员自己的浏览剔除，避免污染 UV/PV/来源/入口/流失
  const rows = await prisma.pageView.findMany({
    where: { isAdmin: false, createTime: { gte: d30 } },
    select: {
      path: true,
      visitorId: true,
      referrer: true,
      isEntry: true,
      sessionId: true,
      uaClass: true,
      dwellMs: true,
      scrollPct: true,
      clicked: true,
      createTime: true,
    },
  });

  // ---- 分日趋势 + 今日/昨日 ----
  const fromIdx = Math.floor((d30 + 28800) / 86400);
  const todayIdx = Math.floor((today0 + 28800) / 86400);
  const trendMap = new Map<number, { pv: number; uv: Set<string> }>();
  for (let i = 0; i < 30; i++) trendMap.set(fromIdx + i, { pv: 0, uv: new Set() });

  const todayUv = new Set<string>();
  const yesterdayUv = new Set<string>();
  const d30Uv = new Set<string>();
  const refMap = new Map<string, number>();
  const deviceMap = new Map<string, number>();
  const entryToday = new Map<string, number>();
  const entryD7 = new Map<string, number>();
  const entryD30 = new Map<string, number>();
  const videoPvToday = new Map<string, { pv: number; uv: Set<string> }>();
  const videoPvD7 = new Map<string, { pv: number; uv: Set<string> }>();
  const videoPvD30 = new Map<string, { pv: number; uv: Set<string> }>();

  // 按时间序处理（流失统计取会话末页依赖顺序）
  const sorted = [...rows].sort((a, b) => N(a.createTime) - N(b.createTime));

  for (const r of sorted) {
    const t = N(r.createTime);
    const idx = Math.floor((t + 28800) / 86400);
    const bucket = trendMap.get(idx);
    if (bucket) {
      bucket.pv += 1;
      bucket.uv.add(r.visitorId);
    }
    d30Uv.add(r.visitorId);
    if (t >= today0) todayUv.add(r.visitorId);
    else if (t >= yesterday0) yesterdayUv.add(r.visitorId);

    if (r.referrer && r.referrer !== "internal") {
      refMap.set(r.referrer, (refMap.get(r.referrer) ?? 0) + 1);
    }
    if (r.isEntry && r.referrer && r.referrer !== "internal") {
      const np = normalizePath(r.path);
      entryD30.set(np, (entryD30.get(np) ?? 0) + 1);
      if (t >= d7) entryD7.set(np, (entryD7.get(np) ?? 0) + 1);
      if (t >= today0) entryToday.set(np, (entryToday.get(np) ?? 0) + 1);
    }
    if (r.uaClass) {
      deviceMap.set(r.uaClass, (deviceMap.get(r.uaClass) ?? 0) + 1);
    }

    const m = r.path.match(VIDEO_RE);
    if (m) {
      const bump = (map: Map<string, { pv: number; uv: Set<string> }>) => {
        let agg = map.get(m[1]);
        if (!agg) {
          agg = { pv: 0, uv: new Set() };
          map.set(m[1], agg);
        }
        agg.pv += 1;
        agg.uv.add(r.visitorId);
      };
      bump(videoPvD30);
      if (t >= d7) bump(videoPvD7);
      if (t >= today0) bump(videoPvToday);
    }
  }

  const dates: string[] = [];
  const pvSeries: number[] = [];
  const uvSeries: number[] = [];
  for (let i = 0; i < 30; i++) {
    const b = trendMap.get(fromIdx + i)!;
    dates.push(new Date((fromIdx + i) * 86400000).toISOString().slice(0, 10));
    pvSeries.push(b.pv);
    uvSeries.push(b.uv.size);
  }

  const entryTop = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, entries]) => ({ path, entries }));

  // ---- 高流失页：会话内按时间序找末页 ----
  const exitPagesFor = (start: number): ExitPage[] => {
    interface SessionLast {
      lastAt: number;
      lastPath: string;
      dwellMs: number | null;
      scrollPct: number | null;
      clicked: boolean | null;
    }
    const sessionMap = new Map<string, SessionLast>();
    const pathPv = new Map<string, number>();
    for (const r of sorted) {
      const t = N(r.createTime);
      if (t < start) continue;
      pathPv.set(r.path, (pathPv.get(r.path) ?? 0) + 1);
      if (!r.sessionId) continue;
      const s = sessionMap.get(r.sessionId);
      if (s) {
        if (t >= s.lastAt) {
          s.lastAt = t;
          s.lastPath = r.path;
          s.dwellMs = r.dwellMs;
          s.scrollPct = r.scrollPct;
          s.clicked = r.clicked;
        }
      } else {
        sessionMap.set(r.sessionId, {
          lastAt: t,
          lastPath: r.path,
          dwellMs: r.dwellMs,
          scrollPct: r.scrollPct,
          clicked: r.clicked,
        });
      }
    }
    // 按末页聚合：退出次数 + 末页 dwell 明细
    interface ExitAgg {
      exits: number;
      dwells: number[];
      scrolls: number[];
      noClick: number;
    }
    const aggMap = new Map<string, ExitAgg>();
    for (const s of sessionMap.values()) {
      // 录像详情页看完即走是正常行为（本站核心内容页），不计入流失榜
      if (VIDEO_RE.test(s.lastPath)) continue;
      const np = normalizePath(s.lastPath);
      let agg = aggMap.get(np);
      if (!agg) {
        agg = { exits: 0, dwells: [], scrolls: [], noClick: 0 };
        aggMap.set(np, agg);
      }
      agg.exits += 1;
      if (s.dwellMs !== null) {
        agg.dwells.push(s.dwellMs);
        if (s.scrollPct !== null) agg.scrolls.push(s.scrollPct);
        if (s.clicked === false) agg.noClick += 1;
      }
    }
    return [...aggMap.entries()]
      .map(([path, agg]) => {
        const pv = pathPv.get(path) ?? 0;
        const covered = agg.dwells.length;
        const medianMs = median(agg.dwells);
        const medianScrollPct = median(agg.scrolls);
        // 诊断：覆盖样本 ≥3 且占退出数一半以上才下结论，否则算积累中
        let type: DiagnosisType = "collecting";
        if (covered >= 3 && covered >= agg.exits * 0.5) {
          const bounceHalf = agg.dwells.filter((d) => d < 10_000).length / covered >= 0.5;
          if (bounceHalf) type = "bounce";
          else if (medianScrollPct !== null && medianScrollPct < 40) type = "shallow";
          else if (
            medianMs !== null &&
            medianMs >= 60_000 &&
            medianScrollPct !== null &&
            medianScrollPct >= 70 &&
            agg.noClick / covered >= 0.6
          )
            type = "read_leave";
          else type = "normal";
        }
        return {
          path,
          pv,
          exits: agg.exits,
          exitRate: pv >= 5 ? agg.exits / pv : -1,
          covered,
          medianMs,
          medianScrollPct,
          noClickPct: covered > 0 ? Math.round((agg.noClick / covered) * 100) : null,
          diagnosis: { type, ...DIAGNOSIS[type] },
        };
      })
      .filter((e) => e.exitRate >= 0)
      .sort((a, b) => b.exitRate - a.exitRate)
      .slice(0, 8);
  };

  // ---- 热门录像页：补玩家名 / 级别 ----
  const topN = (map: Map<string, { pv: number; uv: Set<string> }>) =>
    [...map.entries()]
      .sort((a, b) => b[1].pv - a[1].pv)
      .slice(0, 10)
      .map(([id, agg]) => ({ id: Number(id), pv: agg.pv, uv: agg.uv.size }));

  const metaFor = async (hits: { id: number; pv: number; uv: number }[]): Promise<TrafficHit[]> => {
    if (!hits.length) return [];
    const ids = hits.map((h) => BigInt(h.id));
    const videos = await prisma.video.findMany({
      where: { id: { in: ids } },
      select: { id: true, level: true, user: true },
    });
    const userIds = [...new Set(videos.map((v) => v.user))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, chineseName: true },
    });
    const levelMap = new Map(videos.map((v) => [N(v.id), v.level]));
    const nameMap = new Map(users.map((u) => [N(u.id), u.chineseName]));
    // 录像 id → 上传者 id → 玩家名（nameMap 的 key 是 user.id，与录像 id 是两个空间）
    const ownerMap = new Map(videos.map((v) => [N(v.id), N(v.user)]));
    return hits.map((h) => ({
      label: `#${h.id} ${nameMap.get(ownerMap.get(h.id) ?? -1) ?? "未知玩家"}`,
      path: `/video/${h.id}`,
      level: levelMap.get(h.id) ?? "",
      pv: h.pv,
      uv: h.uv,
    }));
  };

  const [topToday, topD7, topD30] = await Promise.all([
    metaFor(topN(videoPvToday)),
    metaFor(topN(videoPvD7)),
    metaFor(topN(videoPvD30)),
  ]);

  return {
    now,
    today: { pv: trendMap.get(todayIdx)?.pv ?? 0, uv: todayUv.size },
    yesterday: {
      pv: trendMap.get(todayIdx - 1)?.pv ?? 0,
      uv: yesterdayUv.size,
    },
    d30: { pv: rows.length, uv: d30Uv.size },
    trend: { dates, pv: pvSeries, uv: uvSeries },
    referrers: [...refMap.entries()]
      .map(([source, visits]) => ({ source, visits }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 10),
    entryPages: { today: entryTop(entryToday), d7: entryTop(entryD7), d30: entryTop(entryD30) },
    devices: [...deviceMap.entries()]
      .map(([uaClass, pv]) => ({ uaClass, pv }))
      .sort((a, b) => b.pv - a.pv),
    exits: { today: exitPagesFor(today0), d7: exitPagesFor(d7), d30: exitPagesFor(d30) },
    topVideos: { today: topToday, d7: topD7, d30: topD30 },
  };
}

/** 缓存版（铁律：热点统计挂 unstable_cache；改聚合逻辑必须升 key 版本号） */
export const getTrafficOverview = unstable_cache(
  aggregate,
  ["admin-traffic", "v2"],
  { revalidate: 300 }
);

export { DEVICE_NAMES, REFERRER_NAMES };
