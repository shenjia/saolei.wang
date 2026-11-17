// 开源扫雷网 → 雷网：扫描器（2026-11-17 从 openms-sync-all.ts 拆出）
//
// 【职责单一】只拉列表 + 「扫到即入库」登记台账 + 推进 sync_cursor。**绝不下载**。
//   下载交给 openms-download.ts（消费台账 state=0 队列，连续 5 盘/分）。
//
// 【为什么拆】（张老师 2026-11-17 定）
//   单脚本串行「列表+下载」时，大积压用户会把整轮配额吃光，后面的用户连列表都拉不到，
//   新上传的录像要等队头几千盘清完才被扫到。拆开后扫描器每轮穿越**全部** consent=1 用户，
//   纯登记动作（一页 200 条、1 次/2s），几分钟扫完全站；新盘当轮就进下载队列。
//
// 【游标语义】openms_link.sync_cursor = 本用户「已扫描过的最大 video_id」（0=从未同步）。
//   API cursor 是 inclusive 下界，每次请求传 sync_cursor + 1；每页登记完即推进。
//   台账防重复（createMany skipDuplicates），cursor 防重复拉列表 —— 双保险不变。
//
// 【归属硬校验】返回的 saolei_id 必须等于本行雷网 uid；不一致立即停该用户、不推进游标，
//   等人工校正 openms_link.profile（绝不把录像挂到别人名下）。
//
// 【用法】（项目根目录，默认 dry-run，必须 --apply 才写库）
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/openms-scan.ts \
//     [--apply] [--count 200] [--list-gap 2100] [--max-pages 200] \
//     [--users 9952:2,1:207] [--cursor 0] [--ignore-consent] [--max-retries 3]
//
// 【生产 crontab】scripts/server-release.sh 幂等注册，每 10 分钟一轮（flock 防重入）。

import { prisma } from "@/lib/db";
import {
  arg, log, cfg, fetchList, registerScanned, saveCursor,
  startRun, writeRun, endRun, finishOnError,
  RUN_DONE, RUN_PARTIAL,
  type Row, type Link,
} from "./sync/openms-core";

const APPLY = process.argv.includes("--apply");
const IGNORE_CONSENT = process.argv.includes("--ignore-consent");
const PAGE_COUNT = Math.min(2000, Math.max(1, parseInt(arg("count", "200") ?? "200", 10) || 200));
/** 单轮最多拉多少页（安全阀：48 用户 × 各若干页；卡死时不会无限循环） */
const MAX_PAGES = Math.max(1, parseInt(arg("max-pages", "200") ?? "200", 10) || 200);
const CURSOR_OVERRIDE = arg("cursor");
const USERS_OVERRIDE = arg("users");
const RUN_TRIGGER = (process.env.OPENMS_SYNC_TRIGGER ?? "cron").slice(0, 16);

cfg.listGapMs = Math.max(0, parseInt(arg("list-gap", "2100") ?? "2100", 10) || 0);
cfg.retryWaitMs = Math.max(0, Number(arg("retry-wait", "25000") ?? "25000") || 0);
cfg.maxRetries = Math.max(0, parseInt(arg("max-retries", "3") ?? "3", 10) || 0);

async function loadLinks(): Promise<Link[]> {
  if (USERS_OVERRIDE) {
    const parsed = USERS_OVERRIDE.split(",").map((s) => {
      const [u, p] = s.split(":");
      return { user: Number(u), profile: Number(p ?? 0) };
    }).filter((l) => Number.isFinite(l.user) && l.user > 0);
    if (CURSOR_OVERRIDE !== undefined) {
      return parsed.map((l) => ({ ...l, syncCursor: Number(CURSOR_OVERRIDE) }));
    }
    const rows = await prisma.openmsLink.findMany({
      where: { user: { in: parsed.map((l) => BigInt(l.user)) } },
      select: { user: true, syncCursor: true },
    });
    const saved = new Map(rows.map((r) => [Number(r.user), Number(r.syncCursor)]));
    return parsed.map((l) => ({ ...l, syncCursor: saved.get(l.user) ?? 0 }));
  }
  const rows = await prisma.openmsLink.findMany({
    where: IGNORE_CONSENT ? undefined : { consent: 1 },
    select: { user: true, profile: true, syncCursor: true, syncTime: true },
    orderBy: { syncTime: "asc" }, // 最久没同步的优先
  });
  return rows.map((r) => ({
    user: Number(r.user), profile: r.profile,
    syncCursor: CURSOR_OVERRIDE !== undefined ? Number(CURSOR_OVERRIDE) : Number(r.syncCursor),
  }));
}

async function main() {
  const t0 = Date.now();
  log(`[openms-scan] start ${APPLY ? "APPLY" : "DRY-RUN"} count=${PAGE_COUNT} list-gap=${cfg.listGapMs}ms max-pages=${MAX_PAGES}`);
  await startRun("scan", {
    maxItems: MAX_PAGES, pageCount: PAGE_COUNT,
    minGapMs: 0, listGapMs: cfg.listGapMs, maxRetries: cfg.maxRetries,
  }, APPLY);

  const stats = { users: 0, pages: 0, registered: 0, seen: 0, failedUsers: 0 };
  let lastError: string | null = null;
  let currentUser = 0, currentProfile = 0, currentCursor = 0, lastVideoId = 0;
  let beatCount = 0, lastBeatMs = 0, closed = false;

  const beat = async (videoId?: number, force = false) => {
    if (videoId !== undefined) lastVideoId = videoId;
    beatCount++;
    const nowMs = Date.now();
    if (!force && beatCount < 3 && nowMs - lastBeatMs < 30_000) return;
    beatCount = 0;
    lastBeatMs = nowMs;
    await writeRun({
      users: stats.users, pages: stats.pages, handled: stats.registered,
      seen: stats.seen, registered: stats.registered,
      currentUser: BigInt(currentUser), currentProfile, currentCursor: BigInt(currentCursor),
      currentVideoId: BigInt(lastVideoId),
      ...(lastError ? { lastError: lastError.slice(0, 250) } : {}),
    });
  };

  try {
    const links = await loadLinks();
    log(`  待扫描用户 ${links.length} 人${USERS_OVERRIDE ? "（--users 指定）" : IGNORE_CONSENT ? "（忽略 consent）" : "（consent=1）"}`);
    if (!links.length) {
      log("[openms-scan] done (no user)");
      await endRun(RUN_DONE, {}, null);
      closed = true;
      return;
    }
    for (const link of links) {
      if (stats.pages >= MAX_PAGES) break;
      stats.users++;
      const uidValue = link.profile;
      if (!Number.isFinite(uidValue) || uidValue <= 0) { log(`  ! uid=${link.user} 的 profile 无效，跳过`); continue; }
      let cursor = Math.max(0, link.syncCursor);
      currentUser = link.user;
      currentProfile = link.profile;
      currentCursor = cursor;
      await beat(undefined, true);
      const startCursor = cursor;
      let stopUser = false;

      while (stats.pages < MAX_PAGES && !stopUser) {
        const requestCursor = cursor + 1;
        let rows: Row[];
        try {
          rows = await fetchList(requestCursor, uidValue, PAGE_COUNT);
        } catch (e) {
          lastError = `uid=${link.user} 列表失败: ${e instanceof Error ? e.message : String(e)}`;
          log(`  ! ${lastError}`);
          stats.failedUsers++;
          await beat(undefined, true);
          break;
        }
        stats.pages++;
        currentCursor = requestCursor;
        if (!rows.length) { log(`  uid=${link.user} cursor=${requestCursor} 无新增`); await beat(undefined, true); break; }

        // 归属硬校验：逐条比对；遇到错配只登记错配之前的合法前缀，游标不越过错配条
        const ok: Row[] = [];
        for (const row of rows) {
          if (row.saoleiId !== null && Number.isFinite(row.saoleiId) && row.saoleiId !== link.user) {
            lastError = `uid=${link.user} profile=${link.profile} 与返回 saolei_id=${row.saoleiId} 不一致（请校正 openms_link.profile）`;
            log(`  ! ${lastError}`);
            stats.failedUsers++;
            stopUser = true;
            break;
          }
          ok.push(row);
        }
        if (ok.length) {
          if (APPLY) {
            const { fresh, seen } = await registerScanned(ok, link);
            stats.registered += fresh;
            stats.seen += seen;
            cursor = Math.max(cursor, ok[ok.length - 1].id);
            await saveCursor(link.user, cursor);
          } else {
            stats.registered += ok.length;
            log(`  [dry] uid=${link.user} 页 ${ok.length} 条 #${ok[0].id}–#${ok[ok.length - 1].id} 将登记`);
            cursor = Math.max(cursor, ok[ok.length - 1].id);
          }
          currentCursor = cursor;
          await beat(ok[ok.length - 1].id);
        }
        if (stopUser) break;
        if (rows.length < PAGE_COUNT) break;
      }
      log(`  uid=${link.user} cursor ${startCursor} → ${cursor}`);
    }

    log(`[openms-scan] done in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `users=${stats.users} pages=${stats.pages} registered=${stats.registered} seen=${stats.seen} failedUsers=${stats.failedUsers}` +
        (APPLY ? "" : "（dry-run：未登记台账、未推进 cursor、未写 run 表）"));
    await beat(undefined, true);
    await endRun(lastError ? RUN_PARTIAL : RUN_DONE, {}, lastError);
    closed = true;
  } finally {
    if (!closed) await finishOnError(lastError);
    else await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("[openms-scan] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
