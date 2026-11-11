// 开源扫雷网同步录像的「免核定自动过审」（2026-11-11 张老师定）
//
// 【规则】开源扫雷网同步过来的「历史录像」中，满足以下全部条件的，统一由 ID=1 的
//   站长审核通过（status 10→20，reviewer=1）：
//     ① 来源 = 开源扫雷网（video.from_site = OPENMS_FROM_SITE，默认 3，与 openms-sync-all.ts 同值）
//     ② 上传时间（video.create_time，导入时即开源站原始上传时间）距今 > 7 天
//        —— 给近 7 天内新同步的录像留人工复核窗口
//     ③ 自动分拣结果 = 免核定（video.auto_flag = 1）
//
// 【为何走 reviewVideo 权威路径】「审核通过」不是单纯改状态：要正确落 video_scores_*/user_scores、
//   名次落盘、STNB 榜、破纪录/入伍动态、3BV 收集区间、user_stat 计数与首页缓存失效。
//   直接 UPDATE status 会让这些下游全部失同步。故逐盘走 lib/review.reviewVideo，
//   复用与后台「免核定批量一键通过」同款的 skipWatchCheck（池内零触发器命中，分拣闸门保证）。
//
// 【幂等】只筛 status=10 待审，已通过/已屏蔽的自然被排除；重跑安全。
//
// 【范围说明（张老师确认口径）】此脚本是 v2 自动审核「机器永不自动过审」原则的
//   **定向例外**：仅限开源扫雷网同步来源 + >7 天 + 免核定 三条件交集；站内原生上传
//   与其他外站录像不受影响，仍需人工按原流程审核。
//
// 【用法】（默认 dry-run，必须 --apply 才写库；与 openms-sync-all 同加载器）
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/openms-auto-approve.ts \
//     [--apply] [--cutoff-days 7] [--limit 0] [--batch 200] [--from-site 3]
//   --limit 0 = 不限额（处理全部符合条件）；默认 0。
//   --apply 才会真正调 reviewVideo 写库；dry-run 只打印命中清单与计数。

import { prisma } from "@/lib/db";
import { reviewVideo } from "@/lib/review";
import { VIDEO_STATUS } from "@/lib/config";

// 与 openms-sync-all.ts 的 FROM_SITE 同源（开源扫雷网在 api_key 表的 key id）
const FROM_SITE = BigInt(process.env.OPENMS_FROM_SITE ?? "3");
const ADMIN_ID = 1;
const ADMIN_ROLE = 100; // USER_ROLE.ADMINISTRATOR

// ---------------- CLI ----------------
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const APPLY = process.argv.includes("--apply");
const CUTOFF_DAYS = Math.max(0, parseInt(arg("cutoff-days", "7") ?? "7", 10) || 7);
const LIMIT = Math.max(0, parseInt(arg("limit", "0") ?? "0", 10) || 0); // 0=不限
const BATCH = Math.max(1, Math.min(1000, parseInt(arg("batch", "200") ?? "200", 10) || 200));

function log(line: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - CUTOFF_DAYS * 86400;
  log(`[openms-auto-approve] ${APPLY ? "APPLY" : "DRY-RUN"} from_site=${FROM_SITE} cutoff_days=${CUTOFF_DAYS} 截止上传时间=${new Date(cutoff * 1000).toISOString()} limit=${LIMIT || "∞"} batch=${BATCH}`);

  let approved = 0, failed = 0, scanned = 0;
  let lastId = BigInt(0);

  for (;;) {
    const take = LIMIT > 0 ? Math.min(BATCH, LIMIT - scanned) : BATCH;
    if (take <= 0) break;

    const candidates = await prisma.video.findMany({
      where: {
        fromSite: FROM_SITE,
        status: VIDEO_STATUS.NORMAL, // 10 待审
        autoFlag: 1, // 免核定
        createTime: { lte: BigInt(cutoff) },
        id: { gt: lastId },
      },
      select: { id: true, user: true, level: true, createTime: true },
      orderBy: { id: "asc" },
      take,
    });
    if (!candidates.length) break;

    for (const v of candidates) {
      scanned++;
      const id = Number(v.id);
      const uploadedAt = new Date(Number(v.createTime) * 1000).toISOString().slice(0, 10);
      if (!APPLY) {
        log(`  [dry] #${id} 用户${v.user} ${v.level} 上传于 ${uploadedAt} → 将过审`);
        approved++;
        lastId = v.id;
        continue;
      }
      try {
        const r = await reviewVideo(ADMIN_ID, ADMIN_ROLE, id, VIDEO_STATUS.REVIEWED, { skipWatchCheck: true });
        if (r.ok) {
          approved++;
          log(`  ✓ #${id} 用户${v.user} ${v.level} 上传于 ${uploadedAt} → 已通过（reviewer=${ADMIN_ID}）`);
        } else {
          failed++;
          log(`  ✗ #${id} 审核失败: ${r.error}`);
        }
      } catch (e) {
        failed++;
        log(`  ✗ #${id} 异常: ${e instanceof Error ? e.message : String(e)}`);
      }
      lastId = v.id;
    }

    if (LIMIT > 0 && scanned >= LIMIT) break;
  }

  log(`[openms-auto-approve] 完成 ${APPLY ? "APPLY" : "DRY-RUN"}：` +
      `扫描 ${scanned} 盘, 过审 ${approved}, 失败 ${failed}` +
      (APPLY ? "" : "（dry-run：未改动任何数据）"));
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("[openms-auto-approve] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
