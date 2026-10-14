// 跑批：库内已通过录像 → 重放算指标 → video_metrics；再按组分位 → video_metric_dist；最后全站重排。
//
// 用法（必须用 ts loader，否则无扩展名 import 解析不了）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/video-metrics.ts [选项]
// 选项：
//   --limit=N          只处理前 N 个（默认全量）
//   --from=N           从 id 第 N 个偏移开始（配合 --limit 分批）
//   --missing-only     只补 video_metrics 里缺行的（增量，日常用这个）
//   --since=<秒>       只处理 create/update 时间晚于此的录像
//   --dist-only        跳过逐盘写表，仅按现有 video_metrics 重算分位基准
//   --rank-only        只做最后的全站排名重排（不动指标与基准）
//   --no-rank          跳过排名重排（只重放 + 基准）
//
// 幂等：video_metrics 按 id upsert，video_metric_dist 按 (level,noflag,bucket) upsert，
//       排名每次全量重算。
//
// ⚠️ 什么时候必须全量跑（不带 --missing-only）：
//    重放引擎 src/lib/videoradar.ts 的口径变了的时候。2026-10-14 修了「按下/松开」判定
//    （原来按 mouse-down 的格子算，实际应为 mouse-up），Corr/PPC 全线受影响，
//    此时增补跑批只会保留旧的错误值。
//    反过来，正常新增/导入录像不需要全量跑 —— 在线路径已由 lib/review.ts 的 after 钩子
//    自动生成缺行，这里只需定期兜底。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { VIDEO_STATUS } from "../src/lib/config";
import {
  analyzeVideo,
  bbbvBucket,
  buildDist,
  MIN_DIST_SIZE,
  METRIC_KEYS,
  METRICS,
  stnbOf,
} from "../src/lib/videoradar";
import type { MetricKey } from "../src/lib/videoradar";

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

/**
 * 全站综合榜排名重排。
 *
 * 为什么不在插入时算：排名是**相对值**，来一条新录像会把后面所有人的名次往后挤。
 * 但它只依赖 video_metrics 自身的 stnb 分布，用窗口函数 30 万行几秒就刷完了，
 * 不必为此重放进录像文件，所以放在跑批末尾单独做。
 *
 * 口径：RANK() OVER (ORDER BY stnb DESC) 全站；再按 (level, noflag) 来一份组内榜；
 * beat_pct 是全站超越百分比（与雷达气泡里的「超越 xx% 的玩家」同向读数）。
 */
async function rebuildRank() {
  // ① 先全部清零：屏蔽（status=0）/撤销通过后不该再占榜上的名次，否则TOP榜会出现
  //    点不开的录像。先清后写比「只更新有效集合」安全——后者会留下失效行的旧名次。
  await prisma.$executeRawUnsafe(`UPDATE video_metrics SET rank_all = 0, rank_group = 0, beat_pct = 0`);
  // ② 只对「已通过 + 有 STNB」的集合排名
  await prisma.$executeRawUnsafe(`
    UPDATE video_metrics m
      JOIN (
        SELECT t.id,
               RANK() OVER (ORDER BY t.stnb DESC) AS r_all,
               RANK() OVER (PARTITION BY t.level, t.noflag ORDER BY t.stnb DESC) AS r_grp,
               ROUND(100 * (1 - PERCENT_RANK() OVER (ORDER BY t.stnb DESC)), 2) AS bp
        FROM video_metrics t
          JOIN video v ON v.id = t.id
        WHERE t.stnb > 0 AND v.status = ${VIDEO_STATUS.REVIEWED}
      ) x ON x.id = m.id
    SET m.rank_all = x.r_all,
        m.rank_group = x.r_grp,
        m.beat_pct = x.bp
  `);
  const n = await prisma.videoMetrics.count({ where: { stnb: { gt: 0 }, rankAll: { gt: 0 } } });
  console.log(`排名重排完成：${n} 盘入榜（已屏蔽/待审/无 STNB 的不占名次）`);
}

async function main() {
  const limit = Number(arg("limit") ?? 0);
  const offset = Number(arg("from") ?? 0);
  const since = Number(arg("since") ?? 0);
  const missingOnly = has("missing-only");
  const distOnly = has("dist-only");
  const rankOnly = has("rank-only");
  const rows = METRIC_KEYS as MetricKey[];

  if (rankOnly) {
    await rebuildRank();
    return;
  }

  if (!distOnly) {
    const take = limit > 0 ? limit : undefined;
    const infos = await prisma.videoInfo.findMany({
      select: { id: true, filepath: true, board3bv: true, realTime: true, noflag: true },
      orderBy: { id: "asc" },
      skip: offset,
      take,
    });
    const videos = await prisma.video.findMany({
      select: { id: true, level: true, status: true, createTime: true, updateTime: true },
      orderBy: { id: "asc" },
      skip: offset,
      take,
    });
    const meta = new Map(videos.map((v) => [v.id.toString(), v]));

    let existing: Set<string> | null = null;
    if (missingOnly) {
      const done = await prisma.videoMetrics.findMany({ select: { id: true } });
      existing = new Set(done.map((r) => r.id.toString()));
      console.log(`补缺模式：已有 ${existing.size} 行，只处理缺的那些`);
    }

    let ok = 0;
    let noFile = 0;
    let skip = 0;
    for (const info of infos) {
      const v = meta.get(info.id.toString());
      // 只统计已通过录像：六维口径建立在「胜局」前提上
      if (!v || v.status !== VIDEO_STATUS.REVIEWED) continue;
      if (since > 0 && Number(v.updateTime ?? v.createTime ?? 0) <= since) continue;
      if (existing?.has(info.id.toString())) continue;

      const write = async (data: Record<string, number | string | boolean>) => {
        const now = BigInt(Math.floor(Date.now() / 1000));
        await prisma.videoMetrics.upsert({
          where: { id: info.id },
          create: { id: info.id, ...data, createTime: now } as never,
          update: data as never,
        });
      };

      const buf = readVideoFile(info.filepath);
      if (!buf) {
        // 录像实体文件缺失（全站约 286 条，历史遗留）：Corr/PPC/IOE/Cls 无从算起，
        // 但 STNB 与 3BV/s 只依赖库里的 level/3BV/用时（见 videoradar.ts stnbOf），
        // 仍然可以落这两项 —— 综合榜不受缺文件影响。
        // 注意这些行的 cl=0，下面的分位基准会排除它们，免得 0 值污染基准。
        const stnb = stnbOf(v.level, info.board3bv, info.realTime);
        if (stnb > 0 && info.realTime > 0) {
          await write({
            level: v.level,
            noflag: info.noflag,
            realTime: info.realTime,
            bbbv: info.board3bv,
            cl: 0,
            clLeft: 0,
            clRight: 0,
            clDouble: 0,
            ce: 0,
            unflag: 0,
            path: 0,
            bvs: Math.round((info.board3bv / (info.realTime / 1000)) * 1000) / 1000,
            ioe: 0,
            corr: 0,
            cls: 0,
            ppc: 0,
            stnb,
          });
          noFile++;
        } else {
          skip++;
        }
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
      await write({
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
      });
      ok++;
      if ((ok + noFile) % 5000 === 0) console.log(`  ...${ok + noFile} 盘已写入（有文件 ${ok} / 缺文件 ${noFile} / 跳过 ${skip}）`);
    }
    console.log(`逐盘完成：有文件 ${ok}，缺文件仅 STNB ${noFile}，跳过 ${skip}`);
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
    // cl=0 是缺文件的降级行：只有 STNB/3BV/s 有意义，其余全 0，
    // 放进来会把 Corr/PPC 的分位边界整体拉低
    where: { cl: { gt: 0 } },
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

  if (!has("no-rank")) await rebuildRank();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("FAIL", e);
    await prisma.$disconnect();
    process.exit(1);
  });
