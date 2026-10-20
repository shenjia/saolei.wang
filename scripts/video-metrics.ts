// 跑批：库内已通过录像 → 重放算指标 → video_metrics；再按组分位 → video_metric_dist；最后全站重排。
//
// 用法（必须用 ts loader，否则无扩展名 import 解析不了）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/video-metrics.ts [选项]
// 选项：
//   --limit=N          只处理前 N 个（默认全量）
//   --from=N           从 id 第 N 个偏移开始（配合 --limit 分批）
//   --missing-only     只补 video_metrics 里缺行的（增量，日常用这个）
//   --ids=1,2,3        只重算指定 id（逗号分隔）；--ids-file=path 每行一个 id（定点重算）
//   --since=<秒>       只处理 create/update 时间晚于此的录像
//   --dist-only        跳过逐盘写表，仅按现有 video_metrics 重算分位基准
//   --rank-only        只做最后的全站排名重排（不动指标与基准）
//   --no-rank          跳过排名重排（只重放 + 基准）
//   --qg-only          只回填 qg 列（一条 SQL 从本表 real_time×bbbv 直接算，免重放；2026-10-20 加列后的存量回填）
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
  BASE_METRIC_KEYS,
  BASE_METRICS,
  DIST_BUCKET_ALL,
  buildDist,
  MIN_DIST_SIZE,
  percentOf,
  qgOf,
  stnbOf,
} from "../src/lib/videoradar";
import type { BaseMetricKey } from "../src/lib/videoradar";

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
 * 全站「综合分」重算（雷达「综合」轴的落库版本）。
 *
 * ⚠️ **口径变更（2026-10-14 晚张老师定）**：综合轴回归 **STNB 原值** —— 雷达的半径与等级
 * 用 STNB 在「级别 × 模式」组内的分位。composite 列**改存该分位**（0-100），与 beat_pct
 * 同量纲，也与雷达气泡「STNB x，超过 x% 的玩家」读数天然一致。
 * 历史：该列曾存「四轴百分位加权平均」，已弃（compositeOf / COMPOSITE_WEIGHTS 仍留在
 * lib/videoscore.ts 以免动到别处在途引用，但已无生产调用方）。
 *
 * 依赖分位基准，所以必须在 dist 重建之后跑；基准一变，全站综合分都要跟着变。
 * 30 万行逐条 update 太慢（一次 round trip 一盘），这里按 500 一组拼
 * `UPDATE ... CASE id WHEN ... THEN ...` 批量写。
 */
async function rebuildComposite() {
  await prisma.$executeRawUnsafe(`UPDATE video_metrics SET composite = 0`);
  const dists = await prisma.videoMetricDist.findMany();
  const byGroup = new Map<string, (typeof dists)[number]>();
  for (const d of dists) byGroup.set(`${d.level}|${d.noflag ? 1 : 0}|${d.bucket}`, d);

  const rows = await prisma.videoMetrics.findMany({
    select: { id: true, level: true, noflag: true, stnb: true },
  });

  const vals: Array<[string, number]> = [];
  for (const r of rows) {
    const d = byGroup.get(`${r.level}|${r.noflag ? 1 : 0}|${DIST_BUCKET_ALL}`);
    if (!d) continue;
    const dist = String(d.stnb ?? "")
      .split(",")
      .filter((s) => s !== "")
      .map(Number);
    vals.push([r.id.toString(), dist.length ? percentOf(r.stnb, dist, true) : 0]);
  }

  const CHUNK = 500;
  for (let i = 0; i < vals.length; i += CHUNK) {
    const part = vals.slice(i, i + CHUNK);
    const ids = part.map((p) => p[0]).join(",");
    const whens = part.map((p) => `WHEN ${p[0]} THEN ${p[1]}`).join(" ");
    await prisma.$executeRawUnsafe(
      `UPDATE video_metrics SET composite = CASE id ${whens} END WHERE id IN (${ids})`,
    );
  }
  console.log(`综合分（STNB 组内分位）重算：${vals.length} 盘（基准组 ${dists.length} 个）`);
}

/**
 * 组内排名重排。
 *
 * 为什么不在插入时算：排名是**相对值**，来一条新录像会把后面所有人的名次往后挤。
 * 它只依赖 video_metrics 自身的 composite 分布，窗口函数 30 万行几秒刷完，
 * 不必为此重放进录像文件，所以放在跑批末尾单独做。
 *
 * 口径（张老师 2026-10-14 定）：**只排「级别 × 模式」组内**，不排全站——
 * 不同级别放一起比没有意义。rank_all 列保留但不再维护（恒 0）。
 * beat_pct 直接取 composite（= STNB 组内分位），与雷达气泡「STNB x，超过 x% 的玩家」读数一致。
 */
async function rebuildRank() {
  // ① 先全部清零：屏蔽（status=0）/撤销通过后不该再占榜上的名次，否则 TOP 榜会出现
  //    点不开的录像。先清后写比「只更新有效集合」安全——后者会留下失效行的旧名次。
  await prisma.$executeRawUnsafe(`UPDATE video_metrics SET rank_all = 0, rank_group = 0, beat_pct = 0`);
  // ② 只对「已通过 + 有综合分」的集合排名
  await prisma.$executeRawUnsafe(`
    UPDATE video_metrics m
      JOIN (
        SELECT t.id,
               t.composite,
               RANK() OVER (PARTITION BY t.level, t.noflag ORDER BY t.composite DESC) AS r_grp
        FROM video_metrics t
          JOIN video v ON v.id = t.id
        WHERE t.composite > 0 AND v.status = ${VIDEO_STATUS.REVIEWED}
      ) x ON x.id = m.id
    SET m.rank_group = x.r_grp,
        m.beat_pct = x.composite
  `);
  const n = await prisma.videoMetrics.count({ where: { composite: { gt: 0 }, rankGroup: { gt: 0 } } });
  console.log(`组内排名重排完成：${n} 盘入榜（已屏蔽/待审/无综合分的不占名次；全站榜已停用）`);
}

async function main() {
  // QG 存量回填（2026-10-20 加列）：qg 只依赖 real_time×bbbv（表内已有），
  // 一条 UPDATE 直接算，不重放录像文件。与 qgOf 严格同公式：t<0.01s 或 bbbv≤0 记 0。
  if (has("qg-only")) {
    const n = await prisma.$executeRawUnsafe(`
      UPDATE video_metrics
      SET qg = CASE
        WHEN real_time > 10 AND bbbv > 0
          THEN ROUND(POWER(real_time / 1000, 1.7) / bbbv, 3)
        ELSE 0
      END
    `);
    console.log(`qg 存量回填完成：${n} 行`);
    return;
  }

  const limit = Number(arg("limit") ?? 0);
  const offset = Number(arg("from") ?? 0);
  const since = Number(arg("since") ?? 0);
  const missingOnly = has("missing-only");
  const distOnly = has("dist-only");
  const rankOnly = has("rank-only");
  // --ids=1,2,3 或 --ids-file=/path/to/ids.txt（每行一个 id）：只重算指定录像（幂等 upsert）。
  // 用于口径点修后的定点重算（如 MVF 择优口径上线后的 210 条），比全量跑省时且不影响其他行。
  const idsArg = arg("ids");
  const idsFile = arg("ids-file");
  const onlyIds: bigint[] | null = idsArg
    ? idsArg.split(",").map((s) => BigInt(s.trim())).filter((n) => n > BigInt(0))
    : idsFile
      ? readFileSync(idsFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "").map((s) => BigInt(s))
      : null;
  if (onlyIds) {
    console.log(`定点模式：只处理 ${onlyIds.length} 个指定 id`);
  }
  const rows = BASE_METRIC_KEYS as BaseMetricKey[];

  if (rankOnly) {
    await rebuildRank();
    return;
  }

  if (!distOnly) {
    const take = limit > 0 ? limit : undefined;
    const infos = await prisma.videoInfo.findMany({
      select: { id: true, filepath: true, board3bv: true, realTime: true, noflag: true },
      where: onlyIds ? { id: { in: onlyIds } } : undefined,
      orderBy: { id: "asc" },
      skip: offset,
      take,
    });
    const videos = await prisma.video.findMany({
      select: { id: true, level: true, status: true, createTime: true, updateTime: true },
      where: onlyIds ? { id: { in: onlyIds } } : undefined,
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
      // 只统计已通过录像：跑批口径六维建立在「胜局」前提上。
      // 待审录像的指标行由详情页兜底（10-16 张老师定：雷达对非屏蔽开放），不进跑批/基准，
      // 防止审核未过（败局误传等）的行污染分位基准
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
            qg: qgOf(info.board3bv, info.realTime),
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
        qg: m.qg,
      });
      ok++;
      if ((ok + noFile) % 5000 === 0) console.log(`  ...${ok + noFile} 盘已写入（有文件 ${ok} / 缺文件 ${noFile} / 跳过 ${skip}）`);
    }
    console.log(`逐盘完成：有文件 ${ok}，缺文件仅 STNB ${noFile}，跳过 ${skip}`);
  }

  // ---- 分位基准 ----
  // 先清空再重建：分组随样本变化可能消失（如某分段样本跌破阈值），残留旧行会让页面取到过期基准
  await prisma.videoMetricDist.deleteMany({});
  const all = await prisma.$queryRawUnsafe<Array<{
    level: string;
    noflag: boolean;
    bbbv: number;
    bvs: number;
    ioe: number;
    corr: number;
    cls: number;
    ppc: number;
    stnb: number;
  }>>(`
    SELECT m.level, m.noflag, m.bbbv, m.bvs, m.ioe, m.corr, m.cls, m.ppc, m.stnb
    FROM video_metrics m JOIN video v ON v.id = m.id
    WHERE m.cl > 0 AND v.status = ${VIDEO_STATUS.REVIEWED}
  `);
  // 口径：cl>0 排除缺文件降级行；status=20 排除待审行（详情页兜底会为待审录像落行，
  // 但基准只认已过审的胜局——败局误传的待审行不能进分位，否则会把 Corr/IOE 边界拉低）
  console.log(`分位样本总量：${all.length}`);

  type Group = { size: number; vals: Record<BaseMetricKey, number[]> };
  const groups = new Map<string, Group>();
  const groupKey = (level: string, noflag: boolean, bucket: number) => `${level}|${noflag ? 1 : 0}|${bucket}`;
  const push = (key: string, row: Record<BaseMetricKey, number>) => {
    let g = groups.get(key);
    if (!g) {
      g = { size: 0, vals: { stnb: [], bvs: [], ioe: [], corr: [], cls: [], ppc: [] } };
      groups.set(key, g);
    }
    g.size++;
    for (const k of rows) g.vals[k].push(row[k]);
  };
  for (const row of all) {
    // 分组只有「级别 × 模式」一档：bucket 恒为 -1（张老师 2026-10-14 定，不细分 3BV）
    // noflag 走 raw SQL 回来是 0/1 number，转 boolean（groupKey 与 upsert 都按布尔用）
    push(groupKey(row.level, Number(row.noflag) === 1, DIST_BUCKET_ALL), row);
  }

  let written = 0;
  for (const [key, g] of groups) {
    if (g.size < MIN_DIST_SIZE) continue;
    const [level, nf, bucket] = key.split("|");
    const data: Record<string, string | number | boolean> = { level, noflag: nf === "1", bucket: Number(bucket), size: g.size };
    for (const def of BASE_METRICS) {
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

  // ---- 综合分（依赖上面的分位基准） ----
  await rebuildComposite();

  if (!has("no-rank")) await rebuildRank();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("FAIL", e);
    await prisma.$disconnect();
    process.exit(1);
  });
