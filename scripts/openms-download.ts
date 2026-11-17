// 开源扫雷网 → 雷网：下载器（2026-11-17 从 openms-sync-all.ts 拆出）
//
// 【职责单一】只消费台账 openms_video_map 里 state=0 的队列：下载 → 解析 → 上传管线同款
//   校验 → 落文件 → 事务落库（status=10 待审）→ 落定台账结论。**绝不碰列表 API**。
//   队列由 openms-scan.ts 填（每 10 分钟穿越全部 consent=1 用户，新盘当轮入队）。
//
// 【为什么不设「条数配额」】（张老师 2026-11-17 定）
//   唯一的硬限制是对端「下载 5 盘/分」。脚本内两条下载间隔 12.5s 严格打点（= 4.8 盘/分），
//   跑满一趟自然就贴着上限；flock -n 保证不重叠，crontab 每 2 分钟触发一次 --max-downloads 10，
//   上一趟没跑完时本次直接跳过 → 下载几乎连续不断，又绝不超对方限速。
//
// 【队列顺序】**新盘优先**（upload_time 降序，张老师 2026-11-17 定「新盘默认优先」）——
//   历史存量（实测 4.4 万盘，按对端 5 盘/分要 6 天以上才清得完）不能让新上传的录像跟着排队，
//   否则用户在雷网看不到自己刚传的盘。新盘随时插到队头，历史按时间倒序慢慢补。
//   `--order oldest` 可临时切回老盘优先（FIFO）做对账/补漏。
//
// 【临时失败退避】失败项保持 state=0 并累加 attempts，且 update_time 写入当下；
//   查询时跳过「最近 --cooldown 秒内失败过」的行，避免同一条坏盘连续霸占每分钟的下载位。
//   累计失败 (1+max-retries) 次后落定 state=3 放弃并移出队列。
//
// 【用法】（项目根目录，默认 dry-run，必须 --apply 才写库）
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/openms-download.ts \
//     [--apply] [--max-downloads 10] [--min-gap 12500] [--cooldown 180] [--retry-wait 25000] \
//     [--order newest|oldest] [--max-retries 3] [--dry-ids 123456,123457]
//
// 【生产 crontab】scripts/server-release.sh 幂等注册，每 2 分钟一轮（flock 防重入）。

import { prisma } from "@/lib/db";
import {
  arg, log, cfg, importOne, recordMap,
  startRun, writeRun, endRun, finishOnError,
  MAP_PENDING, RUN_DONE, RUN_PARTIAL,
  type Row, type Outcome,
} from "./sync/openms-core";

const APPLY = process.argv.includes("--apply");
/** 单趟最多下载多少条（每 2 分钟触发一次，10 条 × 12.5s ≈ 125s，正好贴合 120s 窗口） */
const MAX_DOWNLOADS = Math.max(1, parseInt(arg("max-downloads", "10") ?? "10", 10) || 10);
/** 失败退避冷却：最近 N 秒内失败过的行本轮不再取，避免坏盘霸占下载位 */
const COOLDOWN_SEC = Math.max(0, parseInt(arg("cooldown", "180") ?? "180", 10) || 0);
/** 调试：只处理指定 ID（dry-run 时也生效，便于验证解析） */
const DRY_IDS = (arg("dry-ids") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const RUN_TRIGGER = (process.env.OPENMS_SYNC_TRIGGER ?? "cron").slice(0, 16);

cfg.downloadGapMs = Math.max(0, parseInt(arg("min-gap", "12500") ?? "12500", 10) || 0);
cfg.retryWaitMs = Math.max(0, Number(arg("retry-wait", "25000") ?? "25000") || 0);
cfg.maxRetries = Math.max(0, parseInt(arg("max-retries", "3") ?? "3", 10) || 0);

/** 队列顺序：newest=新盘优先（默认）；oldest=老盘优先（FIFO，补历史/对账用） */
const ORDER: "newest" | "oldest" = (arg("order", "newest") ?? "newest").toLowerCase() === "oldest" ? "oldest" : "newest";

/** state=0 队列的排序子句（与 --order 对应；同 upload_time 时按 video_id 定序保证稳定） */
const ORDER_BY = ORDER === "newest"
  ? [{ uploadTime: "desc" as const }, { videoId: "desc" as const }]
  : [{ uploadTime: "asc" as const }, { videoId: "asc" as const }];

type QueueRow = {
  videoId: bigint; saoleiId: bigint; profile: number; uploadTime: bigint; attempts: number;
};

/** 取下一批待下载项：state=0、不在失败冷却期内，按 --order 排序（默认新盘优先） */
async function takeQueue(limit: number): Promise<QueueRow[]> {
  const cutoff = BigInt(Math.floor(Date.now() / 1000) - COOLDOWN_SEC);
  return prisma.openmsVideoMap.findMany({
    where: {
      state: MAP_PENDING,
      OR: [{ attempts: 0 }, { updateTime: { lt: cutoff } }],
    },
    orderBy: ORDER_BY,
    take: limit,
    select: { videoId: true, saoleiId: true, profile: true, uploadTime: true, attempts: true },
  });
}

async function takeByIds(ids: number[]): Promise<QueueRow[]> {
  return prisma.openmsVideoMap.findMany({
    where: { videoId: { in: ids.map((n) => BigInt(n)) } },
    orderBy: ORDER_BY,
    select: { videoId: true, saoleiId: true, profile: true, uploadTime: true, attempts: true },
  });
}

async function main() {
  const t0 = Date.now();
  log(`[openms-download] start ${APPLY ? "APPLY" : "DRY-RUN"} max-downloads=${MAX_DOWNLOADS} min-gap=${cfg.downloadGapMs}ms cooldown=${COOLDOWN_SEC}s max-retries=${cfg.maxRetries} order=${ORDER}`);
  await startRun("download", {
    maxItems: MAX_DOWNLOADS, pageCount: 0,
    minGapMs: cfg.downloadGapMs, listGapMs: 0, maxRetries: cfg.maxRetries,
  }, APPLY);

  const stats = { ok: 0, skip: 0, retry: 0, gaveUp: 0 };
  let handled = 0;
  let lastError: string | null = null;
  let currentUser = 0, currentProfile = 0, currentVideoId = 0;
  let closed = false;

  const beat = async (force = false) => {
    await writeRun({
      handled, ok: stats.ok, skip: stats.skip, retry: stats.retry, gaveUp: stats.gaveUp,
      users: currentUser > 0 ? 1 : 0,
      currentUser: BigInt(currentUser), currentProfile,
      currentVideoId: BigInt(currentVideoId),
      ...(lastError ? { lastError: lastError.slice(0, 250) } : {}),
    });
    void force;
  };

  try {
    const queue = DRY_IDS.length ? await takeByIds(DRY_IDS) : await takeQueue(MAX_DOWNLOADS);
    if (!queue.length) {
      log("  队列空（或待处理项全在失败冷却期内），本轮不下载");
      await endRun(RUN_DONE, { handled: 0, ok: 0, skip: 0, retry: 0, gaveUp: 0 }, null);
      closed = true;
      return;
    }
    log(`  待下载 ${queue.length} 条（${ORDER === "newest" ? "新盘优先" : "老盘优先"}）首 #${queue[0].videoId} → 末 #${queue[queue.length - 1].videoId}`);

    for (const item of queue) {
      if (handled >= MAX_DOWNLOADS) break;
      const row: Row = { id: Number(item.videoId), uploadSec: Number(item.uploadTime), saoleiId: Number(item.saoleiId) };
      const link = { user: Number(item.saoleiId), profile: item.profile };
      currentUser = link.user;
      currentProfile = link.profile;
      currentVideoId = row.id;

      if (!APPLY) {
        log(`  [dry] 开源 #${row.id} 上传于 ${new Date(row.uploadSec * 1000).toISOString()} → 用户 ${link.user}（无 --apply 不下载）`);
        handled++;
        await beat(true);
        continue;
      }

      let out: Outcome;
      try {
        out = await importOne(row, link.user);
      } catch (e) {
        out = { kind: "retry", reason: `未捕获异常: ${e instanceof Error ? e.message : String(e)}` };
      }
      handled++;
      if (out.kind === "ok") {
        stats.ok++;
        log(`  ✓ 开源 #${row.id} → 雷网 #${out.videoId} @${row.uploadSec}`);
      } else if (out.kind === "skip") {
        stats.skip++;
        log(`  - 开源 #${row.id} 跳过: ${out.reason}`);
      } else {
        stats.retry++;
        lastError = `开源 #${row.id} 临时失败: ${out.reason}`;
        const { gaveUp } = await recordMap(row, link, out, item.attempts);
        if (gaveUp) {
          stats.gaveUp++;
          log(`  × 开源 #${row.id} 重试 ${cfg.maxRetries} 次仍失败，落定放弃并移出队列: ${out.reason}`);
        } else {
          log(`  ! 开源 #${row.id} 临时失败（cooldown ${COOLDOWN_SEC}s 后再试）: ${out.reason}`);
        }
      }
      if (out.kind !== "retry") await recordMap(row, link, out, item.attempts);
      await beat(true);
    }

    log(`[openms-download] done in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `handled=${handled} ok=${stats.ok} skip=${stats.skip} retry=${stats.retry} gaveUp=${stats.gaveUp}` +
        (APPLY ? "" : "（dry-run：未下载、未落库、未写 run 表）"));
    await endRun(lastError ? RUN_PARTIAL : RUN_DONE, {
      handled, ok: stats.ok, skip: stats.skip, retry: stats.retry, gaveUp: stats.gaveUp,
    }, lastError);
    closed = true;
  } finally {
    if (!closed) await finishOnError(lastError);
    else await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("[openms-download] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
