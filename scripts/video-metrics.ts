// 跑批：库内已通过录像 → 重放算指标 → video_metrics；再按组分位 → video_metric_dist
//
// 用法（必须用 ts loader，否则无扩展名 import 解析不了）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/video-metrics.ts [选项]
// 选项：
//   --limit=N      只处理前 N 个（默认全量）
//   --from=N       从 id 第 N 个偏移开始（配合 --limit 分批）
//   --dist-only    跳过逐盘写表，仅按现有 video_metrics 重算分位基准
//   --since=<秒>   只处理 update/create 时间晚于此的录像（增量跑批）
//
// 幂等：video_metrics 按 id upsert，video_metric_dist 按 (level,noflag,bucket) upsert。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { analyzeVideo, bbbvBucket, buildDist, MIN_DIST_SIZE, METRIC_KEYS, METRICS } from "../src/lib/videoradar";
import type { MetricKey } from "../src/lib/videoradar";
import type { VideoMetrics } from "../src/lib/videoradar";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function readVideoFile(filepath: string): Uint8Array | null {
  // filepath 形如 /2007/01/05/xxx.mvf（相对 videos 根）
  try {
    const full = path.resolve(VIDEOS_ROOT, "." + filepath);
    if (!full.startsWith(VIDEOS_ROOT + path.sep)) return null;
    return new Uint8Array(readFileSync(full));
  } catch {
    return null;
  }
}

async function main() {
  const limit = Number(arg("limit") ?? 0);
  const offset = Number(arg("from") ?? 0);
  const distOnly = has("dist-only");
  const rows = METRIC_KEYS as MetricKey[];

  if (!distOnly) {
    const infos = await prisma.videoInfo.findMany({
      select: { id: true, filepath: true, board3bv: true, realTime: true, noflag: true },
      orderBy: { id: "asc" },
      skip: offset,
      take: limit > 0 ? limit : undefined,
    });
    const videos = await prisma.video.findMany({
      select: { id: true, level: true, status: true },
      orderBy: { id: "asc" },
      skip: offset,
      take: limit > 0 ? limit : undefined,
    });
    const meta = new Map(videos.map((v) => [v.id.toString(), v]));
    let ok = 0;
    let skip = 0;
    for (const info of infos) {
      const v = meta.get(info.id.toString());
      // 只统计已通过录像：六维口径建立在「胜局」前提上
      if (!v || v.status !== 20) {
        skip++;
        continue;
      }
      const buf = readVideoFile(info.filepath);
      if (!buf) {
        skip++;
        continue;
      }
      const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
      const m = analyzeVideo(buf, ext, {
        level: v.level,
        noflag: info.noflag,
        bbbvFallback: info.board3bv,
        // 用时/3BV 一律以库为准（文件内 Time 在 1119 盘早期 mvf 上不可信）
        timeMs: info.realTime,
        bbbv: info.board3bv,
      });
      if (!m) {
        skip++;
        continue;
      }
      const now = BigInt(Math.floor(Date.now() / 1000));
      const data = {
        level: m.level,
        noflag: m.noflag,
        realTime: info.realTime,
        bbbv: m.bbbv,
        cl: m.cl,
        clLeft: m.clLeft,
        clRight: m.clRight,
        clDouble: m.clDouble,
        ce: m.ce,
        unflag: m.unflag,
        path: m.path,
        bvs: m.bvs,
        ioe: m.ioe,
        corr: m.corr,
        cls: m.cls,
        ppc: m.ppc,
        stnb: m.stnb,
      };
      await prisma.videoMetrics.upsert({
        where: { id: info.id },
        create: { id: info.id, ...data, createTime: now },
        update: { ...data },
      });
      ok++;
      if (ok % 2000 === 0) console.log(`  ...${ok} 盘已写入（跳过 ${skip}）`);
    }
    console.log(`逐盘完成：写入 ${ok}，跳过 ${skip}`);
  }

  // ---- 分位基准 ----
  // 先清空再重建：分组随样本变化可能消失（如某分段样本跌破阈值），残留旧行会让页面取到过期基准
  await prisma.videoMetricDist.deleteMany({});
  const all = await prisma.videoMetrics.findMany({
    select: {
      level: true,
      noflag: true,
      bbbv: true,
      bvs: true,
      ioe: true,
      corr: true,
      cls: true,
      ppc: true,
      stnb: true,
    },
  });
  console.log(`分位样本总量：${all.length}`);

  type Group = { size: number; vals: Record<MetricKey, number[]> };
  const groups = new Map<string, Group>();
  const groupKey = (level: string, noflag: boolean, bucket: number) => `${level}|${noflag ? 1 : 0}|${bucket}`;
  const push = (key: string, row: (typeof all)[number]) => {
    let g = groups.get(key);
    if (!g) {
      g = { size: 0, vals: { stnb: [], bvs: [], ioe: [], corr: [], cls: [], ppc: [] } };
      groups.set(key, g);
    }
    g.size++;
    for (const k of rows) g.vals[k].push(row[k]);
  };
  for (const row of all) {
    // -1 行＝全组兜底；细分段样本不足时用
    push(groupKey(row.level, row.noflag, -1), row);
    push(groupKey(row.level, row.noflag, bbbvBucket(row.level, row.bbbv)), row);
  }

  let written = 0;
  for (const [key, g] of groups) {
    if (g.size < MIN_DIST_SIZE) continue;
    const [level, nf, bucket] = key.split("|");
    const data: Record<string, string | number | boolean> = { level, noflag: nf === "1", bucket: Number(bucket), size: g.size };
    for (const def of METRICS) {
      data[def.key] = buildDist(g.vals[def.key], def.highIsBetter)
        .map((v) => String(Math.round(v * 1000) / 1000))
        .join(",");
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    await prisma.videoMetricDist.upsert({
      where: { level_noflag_bucket: { level, noflag: nf === "1", bucket: Number(bucket) } },
      create: { ...data, createTime: now } as never,
      update: { size: g.size, stnb: data.stnb as string, bvs: data.bvs as string, ioe: data.ioe as string, corr: data.corr as string, cls: data.cls as string, ppc: data.ppc as string },
    });
    written++;
  }
  console.log(`分位行写入：${written}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("FAIL", e);
    await prisma.$disconnect();
    process.exit(1);
  });
