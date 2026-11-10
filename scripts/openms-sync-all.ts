// 开源扫雷网 → 雷网 批量录像同步（2026-11-10 按对方定稿 API 修订）
//
// 【接口定稿】https://openms.top/api/docs#operation/accountlink_saolei_api_unmapped_videos
//   GET /api/accountlink/saolei/unmapped_videos?user_id=<开源站UserProfile.id>&cursor=<n>&count=<n>
//   返回裸数组 UnmappedVideoOut[]，按 video_id 升序：
//     { saolei_id: 雷网用户ID, video_id: 开源站本地录像ID, upload_time: ISO8601 UTC }
//   - cursor 是 **inclusive 下界**（video_id >= cursor）；继续时必须传「最后一条 video_id + 1」
//   - count 默认 1000、上限 2000；返回行数不足 count 即已到底
//   - user_id = 开源站 UserProfile ID（即本地 openms_link.profile），省略=所有已绑定用户
//   - ⚠️ 实测 2026-11-10：省略 user_id 会稳定 504（nginx 5s 超时，对方全表扫描），
//     故本脚本一律按用户遍历、必带 user_id；列表限速 1/2s（IP），下载限速 5/m
//   - 下载 GET /api/video/download/{video_id}，Content-Disposition 保留原软件后缀
//   - unmapped = 开源站本地录像中尚未被 SaoleiApiVideo 映射的。按「两站各抓各的」协议，
//     我方导入不回写对方映射表，靠 (from_site,from_id) 幂等 + sync_cursor 保证不重复导入。
//
// 【游标语义】openms_link.sync_cursor = 本用户「已处理过的最大 video_id」（0=从未同步）。
//   因 API 为 inclusive，每次请求传 sync_cursor + 1；每处理一条即把最大 id 落库。
//
// 【台账／映射库 openms_video_map】（2026-11-10 张老师定）
//   「扫到的录像都入库，不管有没有同步、这边接不接受；以后同步先从库里按 ID 过滤，
//     已经扫过的不重复处理。」
//   - 列表拉到的每个 video_id 立即登记（state=0 待处理），不管本轮是否轮到它处理；
//   - 下载/解析/校验后落定终态：1=已导入雷网（记 import_video_id）、2=明确拒收（记原因）；
//   - 临时失败（429/5xx/落库异常）保持 state=0 并累加 attempts，跨轮跑批重试；
//     首次失败后最多再重试 3 次（--max-retries，即累计 4 次失败），仍失败即落定 state=3 放弃，
//     写原因并越过该 ID 继续往后，避免一条坏录像永久卡住流水线（2026-11-10 张老师定）；
//   - 以后每页先按 video_id 批量查台账，state 1/2/3 直接跳过：不下载、不解析、不落库，
//     也不计入 --max-items 配额；cursor 照常推进。
//   - 双保险：cursor 防重复拉列表页，台账防 cursor 回退/重置/对方重放旧 ID 时重复下载。
//   - 表在 prisma/schema.prisma 内定义（生产由 CI 的 db push 加法自动建；生产库禁 schema 外建表）。
//
// 【跑批记录 openms_sync_run】（2026-11-10 后台仪表盘状态卡）
//   每轮 --apply 写一行：启动 insert、处理中按「每 5 条或 30 秒」更新心跳与计数、
//   正常/部分失败/异常终止写 finished_at + status；dry-run 不写，避免测试污染历史。
//   心跳不能只在页末更新：页内 20 盘按 12.5s 下载间隔可达 250s，会被 180s 阈值误判卡住。
//
// 【本脚本逻辑】（张老师 2026-11-10 定）
//   定时遍历库中已绑定开源扫雷网的用户（默认仅 consent=1 明确同意者）
//   → 每用户取 sync_cursor 作 cursor 分页拉未映射录像
//   → 本页全部 ID 登记台账 → 已有终态的按 ID 过滤跳过
//   → (from_site,from_id) 幂等 → 限速下载原文件 → 解析 + 上传管线同款校验
//   → 按 API 返回的上传时间替用户落库（status=10 待审），不写动态、不占上传额度
//   → 成功/拒收/临时失败各自回写台账，并写回 openms_link.sync_cursor；
//     尚有重试机会的临时失败不越过该 ID，下轮重试；耗尽则落定放弃并越过。
//
// 【用法】（项目根目录，默认 dry-run，必须 --apply 才写库）
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/openms-sync-all.ts \
//     [--apply] [--max-items 20] [--count 200] [--min-gap 12500] [--list-gap 2100] \
//     [--users 9952:2,1:207] [--cursor 0] [--ignore-consent] [--max-retries 3]
//   注：--users 格式为 <雷网uid>:<开源站profile>，profile 必填（API 只认它）。
//       --max-retries = 首次临时失败后允许的跨轮重试次数（默认 3，即累计 4 次失败后放弃）。
//
// 【生产 crontab】（部署脚本 scripts/server-release.sh 幂等注册，flock 防重入）
//   */10 * * * * cd /home/deploy/saolei.wang && /usr/bin/flock -n /tmp/openms-sync-all.lock \
//     /usr/bin/env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/openms-sync-all.ts --apply \
//     --max-items 20 >> /home/deploy/logs/openms-sync.log 2>&1
//   手动补跑时设 OPENMS_SYNC_TRIGGER=manual 区分触发来源。
//
// 【生产库列状态】（2026-11-10 核验）：
//   sync_cursor / sync_time 生产已存在，无需加法 DDL。
//   openms_video_map 由本线 schema 随 CI 的 prisma db push 加法自动建表（生产禁 schema 外建表）。
//   sync_to_openms 两列按张老师 2026-11-10 口径「不删也没事，只要不用它」永久保留：
//   代码／API／UI 零引用，schema 保留字段映射仅作兼容，绝不执行 DROP——删列会让 db push
//   要求 --accept-data-loss 而中止部署，旧 Prisma Client 也会 SELECT 全列导致 500。

import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvfBest } from "@/lib/mvf-best";
import { evfToRawvf } from "@/lib/evf";
import { formatRawvf } from "@/lib/rawvf";
import { judgeVideoOutcome } from "@/lib/videowin";
import { applyFlags } from "@/lib/videoflags";
import { replayEvents } from "@/lib/videoradar";
import { ONLINE_PROGRAM_MARKER } from "@/lib/avfwrite";
import { RANKED_SOFTWARE } from "@/lib/evfwrite";
import { ensureVideoTriage } from "@/lib/videometrics";
import { LEVEL_MIN_3BV, VIDEO_STATUS, type VideoLevel } from "@/lib/config";
import { checkSensitive } from "@/lib/sensitive";
import { userTitleSnapshot } from "@/lib/queries";

// ---------------- 配置区：接口已定稿，仍保留 env 覆盖便于联调/灰度 ----------------
const env = (k: string, d: string) => process.env[k] ?? d;
const OPENMS_BASE = env("OPENMS_BASE", "https://openms.top");
/** 未映射录像列表接口（对方 2026-11-10 定稿） */
const LIST_PATH = env("OPENMS_LIST_PATH", "/api/accountlink/saolei/unmapped_videos");
/** 原文件下载路径，{id} 为 video_id；响应 Content-Disposition 保留原软件后缀 */
const DOWNLOAD_PATH = env("OPENMS_DOWNLOAD_PATH", "/api/video/download/{id}");
/** 用户过滤参数名：值是开源站本地 UserProfile.id，不是雷网 uid */
const UID_PARAM = env("OPENMS_UID_PARAM", "user_id");
/** 该参数传开源站 profile（= openms_link.profile）；lei=雷网 uid（联调排障用） */
const UID_SOURCE = env("OPENMS_UID_SOURCE", "profile");
/** 响应字段名（UnmappedVideoOut 定稿），逗号分隔，取第一个非空值 */
const ID_KEYS = env("OPENMS_FIELD_ID", "video_id,id").split(",");
const UID_KEYS = env("OPENMS_FIELD_UID", "saolei_id,saolei_uid,saolei_user_id,uid").split(",");
const TIME_KEYS = env("OPENMS_FIELD_TIME", "upload_time,uploadTime,time").split(",");

/** 开源扫雷网在 api_key 表的 key id（from_site 落此值；BigInt 字面量禁用→BigInt()） */
const FROM_SITE = BigInt(3);
const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const MAX_SIZE = 500 * 1024;
const EXTS = ["avf", "evf", "mvf"] as const;
type Ext = (typeof EXTS)[number];

// ---------------- CLI ----------------
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const APPLY = process.argv.includes("--apply");
const IGNORE_CONSENT = process.argv.includes("--ignore-consent");
const MAX_ITEMS = Math.max(1, parseInt(arg("max-items", "20") ?? "20", 10) || 20);
const PAGE_COUNT = Math.min(2000, Math.max(1, parseInt(arg("count", "200") ?? "200", 10) || 200));
const MIN_GAP_MS = Math.max(0, parseInt(arg("min-gap", "12500") ?? "12500", 10) || 0);
/** 列表接口对方限速 1/2s（IP），两次列表请求最小间隔；下载另按 5/m 限速 */
const LIST_MIN_GAP_MS = Math.max(0, parseInt(arg("list-gap", "2100") ?? "2100", 10) || 0);
/** 临时故障（429/5xx/网络异常）重试退避；离线联调可设 0 加速 */
const RETRY_WAIT_MS = Math.max(0, Number(arg("retry-wait", "25000") ?? "25000") || 0);
/** 首次临时失败后允许的跨轮重试次数；累计 (1+MAX_RETRIES) 次失败即落定放弃（张老师 2026-11-10 定） */
const MAX_RETRIES = Math.max(0, parseInt(arg("max-retries", "3") ?? "3", 10) || 0);
/** 跑批记录触发来源（cron / 手动补跑 manual） */
const RUN_TRIGGER = env("OPENMS_SYNC_TRIGGER", "cron").slice(0, 16);
/** 每处理 N 条或距上次心跳 30s 即写一次 run 心跳（防止页内长下载被误判卡住） */
const RUN_HEARTBEAT_EVERY = 5;
const RUN_RUNNING = 0, RUN_DONE = 1, RUN_PARTIAL = 2, RUN_FAILED = 3;
const CURSOR_OVERRIDE = arg("cursor");
/** 调试/试跑：--users <雷网uid>:<开源站profile>[,...]，profile 必填（API 只认它） */
const USERS_OVERRIDE = arg("users");

// ---------------- 工具 ----------------
function log(line: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
/** 严格取 API 返回的上传时间（Unix 秒）；支持秒/毫秒数字、数字串、ISO 8601。禁止用 Date.now() 兜底 */
function parseUploadTime(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  throw new Error(`无法解析上传时间: ${JSON.stringify(v)}`);
}
async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      // 429 与 5xx（对端 nginx 5s 超时会回 504）都属临时故障，退避重试
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        log(`  HTTP ${res.status}，等 ${RETRY_WAIT_MS}ms 重试 (${url.split("?")[0]})`);
        await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
}

/**
 * 导入版本线（2026-11-07 张老师定，独立于站内上传通道的 checkProgramVersion）：
 * 只导入 Arbiter（不限版本）、元扫雷 ≥3.2.2（含）、Vienna ≥4.0.0；其余软件（Clone 等）不导入。
 */
function checkImportVersion(program: string, version: string): string | null {
  const verCompare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const p = program.trim();
  if (/^Arbiter\b/.test(p)) return null;
  if (p === "元扫雷") {
    const mv = /^(\d+(?:\.\d+){1,3})$/.exec(version.trim());
    if (!mv) return `无法识别元扫雷版本（${version.trim() || "空"}），导入线 3.2.2`;
    if (verCompare(mv[1].split(".").map(Number), [3, 2, 2]) < 0) return `元扫雷版本过低（${mv[1]}），导入线 3.2.2`;
    return null;
  }
  if (p === "Vienna" || p === "Viennasweeper") {
    const nv = /^(\d+(?:\.\d+)*)/.exec(version.trim());
    if (!nv) return `无法识别 Vienna 版本（${version.trim() || "空"}），导入线 4.0.0`;
    if (verCompare(nv[1].split(".").map(Number), [4, 0, 0]) < 0) return `Vienna 版本过低（${version.trim()}），导入线 4.0.0`;
    return null;
  }
  return `软件不在导入范围（${p || "未知"}）`;
}

// ---------------- 类型 ----------------
type Row = { id: number; uploadSec: number; saoleiId: number | null };
type Link = { user: number; profile: number; syncCursor: number };
type Outcome =
  | { kind: "ok"; videoId: number; hash: string }
  | { kind: "skip"; reason: string; importedVideoId?: number; hash?: string }
  | { kind: "retry"; reason: string };

// ---------------- 列表 API ----------------
let lastListAt = 0;
/** cursor 原样传给 API（inclusive 下界）；调用方负责传「已处理最大 id + 1」 */
async function fetchList(cursor: number, uidValue: number): Promise<Row[]> {
  const wait = LIST_MIN_GAP_MS - (Date.now() - lastListAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastListAt = Date.now();
  const url = new URL(LIST_PATH, OPENMS_BASE);
  url.searchParams.set("cursor", String(cursor));
  url.searchParams.set("count", String(PAGE_COUNT));
  url.searchParams.set(UID_PARAM, String(uidValue));
  const res = await fetchWithRetry(url.toString());
  if (!res.ok) throw new Error(`列表 API HTTP ${res.status} (${url.pathname})`);
  const json: unknown = await res.json();
  const arr: unknown = Array.isArray(json)
    ? json
    : (json as Record<string, unknown>)?.items ??
      (json as Record<string, unknown>)?.data ??
      (json as Record<string, unknown>)?.results;
  if (!Array.isArray(arr)) throw new Error(`列表 API 返回不是数组: ${JSON.stringify(json).slice(0, 200)}`);
  if (arr.length && ID_KEYS.every((k) => (arr[0] as Record<string, unknown>)[k] === undefined)) {
    throw new Error(`字段名不匹配：首条 keys=${Object.keys(arr[0] as object).join(",")}，请设 OPENMS_FIELD_ID/UID/TIME`);
  }
  return (arr as Record<string, unknown>[])
    .map((o): Row => {
      const id = Number(pick(o, ID_KEYS));
      if (!Number.isFinite(id) || id <= 0) throw new Error(`非法录像 id: ${JSON.stringify(o).slice(0, 160)}`);
      const rawUid = pick(o, UID_KEYS);
      return {
        id,
        uploadSec: parseUploadTime(pick(o, TIME_KEYS)),
        saoleiId: rawUid === undefined || rawUid === null || rawUid === "" ? null : Number(rawUid),
      };
    })
    .sort((a, b) => a.id - b.id); // 防御性排序：cursor 语义依赖升序
}

// ---------------- 单盘导入 ----------------
let lastDownloadAt = 0;
async function importOne(row: Row, leiUid: number): Promise<Outcome> {
  // ① 幂等：本站已导入过该开源站录像
  const dup = await prisma.video.findFirst({
    where: { fromSite: FROM_SITE, fromId: BigInt(row.id) },
    select: { id: true },
  });
  if (dup) return { kind: "skip", reason: "已导入", importedVideoId: Number(dup.id) };

  // ② 限速下载（距上次下载 ≥ MIN_GAP_MS，默认 5 次/分钟）
  const wait = MIN_GAP_MS - (Date.now() - lastDownloadAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDownloadAt = Date.now();
  const dlUrl = DOWNLOAD_PATH.includes("{id}")
    ? DOWNLOAD_PATH.replace("{id}", String(row.id))
    : `${DOWNLOAD_PATH}${row.id}`;
  let dl: Response;
  try {
    dl = await fetchWithRetry(new URL(dlUrl, OPENMS_BASE).toString());
  } catch (e) {
    return { kind: "retry", reason: `下载异常: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (dl.status === 429 || dl.status >= 500) return { kind: "retry", reason: `下载 HTTP ${dl.status}` };
  if (!dl.ok) return { kind: "skip", reason: `下载 HTTP ${dl.status}` };
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length > MAX_SIZE) return { kind: "skip", reason: "size>500KB" };

  // ③ 原始后缀：优先 Content-Disposition；新 API 无 software 字段，缺失时三种解析器全试
  const cd = dl.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  const hinted = m ? path.extname(decodeURIComponent(m[1])).slice(1).toLowerCase() : "";
  const tried: Ext[] = EXTS.includes(hinted as Ext)
    ? [hinted as Ext, ...EXTS.filter((e) => e !== hinted)]
    : [...EXTS];
  let ext: Ext | null = null;
  let lines: string[] | null = null;
  for (const e of tried) {
    try {
      const got = e === "avf" ? avfToRawvf(buf) : e === "evf" ? evfToRawvf(buf) : (mvfToRawvfBest(buf)?.lines ?? null);
      if (got) { ext = e; lines = got; break; }
    } catch { /* 换下一种 */ }
  }
  if (!lines || !ext) return { kind: "skip", reason: "解析失败（三种格式均不匹配）" };

  // ④ MD5 查重（下载后算；对方 API 暂不提供 file_md5，定稿后可提前过滤省流量）
  const hash = createHash("md5").update(buf).digest("hex");
  const md5Dup = await prisma.video.findFirst({ where: { hash }, select: { id: true } });
  if (md5Dup) return { kind: "skip", reason: `md5 雷网已有 #${md5Dup.id}`, hash };

  // ⑤ 上传管线同款校验
  const parsed = formatRawvf(lines);
  if (parsed.version === "<=0.96") return { kind: "skip", reason: "版本<=0.96" };
  const tooOld = checkImportVersion(parsed.program, parsed.version);
  if (tooOld) return { kind: "skip", reason: tooOld };
  if (parsed.program.includes(ONLINE_PROGRAM_MARKER)) return { kind: "skip", reason: "在线玩录像" };
  if (parsed.program === RANKED_SOFTWARE) return { kind: "skip", reason: "排名软件" };
  if (!(parsed.level in LEVEL_MIN_3BV)) return { kind: "skip", reason: `level=${parsed.level}` };
  if (parsed.mode !== "classic") return { kind: "skip", reason: `mode=${parsed.mode}` };
  if (!parsed.events.some((l) => /^[-\d.]+ mv /.test(l))) return { kind: "skip", reason: "手机录像(无mv)" };
  if (parsed.solved3bv !== null) {
    if (parsed.solved3bv < (parsed.bbbv ?? 0)) return { kind: "skip", reason: "未完成(solved3bv)" };
  } else {
    const outcome = judgeVideoOutcome(parsed);
    if (outcome !== "win") return { kind: "skip", reason: `未完成(${outcome})` };
  }
  const level = parsed.level as VideoLevel;
  const noRecord = (parsed.bbbv ?? 0) < LEVEL_MIN_3BV[level];
  const sigHit = checkSensitive(parsed.player);
  if (!sigHit.ok) return { kind: "skip", reason: "敏感词标识" };

  // ⑥ 落文件（目录按 API 返回的上传时间 +08:00 日期，内容 MD5 命名）
  const ts = BigInt(row.uploadSec);
  const d = new Date((row.uploadSec + 28800) * 1000);
  const dir = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const filepath = `/${dir}/${hash}.${ext}`;
  const absDir = path.join(VIDEOS_ROOT, dir);
  if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
  writeFileSync(path.join(absDir, `${hash}.${ext}`), buf);

  // ⑦ 事务落库（镜像上传路由：签名/称号快照/本BV/四表；status=10 待审）
  let imported: number;
  try {
    imported = await prisma.$transaction(async (tx) => {
      const sig = await tx.userSig.findFirst({ where: { signature: parsed.player } });
      if (sig && Number(sig.user) !== leiUid) throw new Error(`SIG_TAKEN:${sig.user}`);
      if (!sig) await tx.userSig.create({ data: { user: BigInt(leiUid), signature: parsed.player, createTime: ts } });
      const snap = await userTitleSnapshot(leiUid, tx);
      let firstBv = 0, pbBv = 0;
      if (!noRecord) {
        const prevAgg = await tx.$queryRaw<{ c: bigint; mt: number | null }[]>`
          SELECT COUNT(*) AS c, MIN(vi.real_time) AS mt
          FROM video v JOIN video_info vi ON vi.id = v.id
          WHERE v.\`user\` = ${BigInt(leiUid)} AND v.level = ${level}
            AND vi.board_3bv = ${parsed.bbbv ?? 0} AND v.status <> ${VIDEO_STATUS.BANNED}`;
        const prevCount = Number(prevAgg[0]?.c ?? 0);
        const prevBest = prevAgg[0]?.mt ?? null;
        firstBv = prevCount === 0 ? 1 : 0;
        pbBv = prevCount > 0 && prevBest !== null && parsed.timeMs > 0 && parsed.timeMs < prevBest ? 1 : 0;
      }
      let boardWithFlags = parsed.board;
      try { boardWithFlags = applyFlags(parsed.board, replayEvents(parsed).flagged); } catch { /* 降级纯雷位 */ }
      const video = await tx.video.create({
        data: {
          level, user: BigInt(leiUid), hash,
          status: VIDEO_STATUS.NORMAL, // 10 待审
          expTime: BigInt(snap.expTime), ranked: snap.ranked ? BigInt(1) : BigInt(0),
          firstBv, pbBv,
          fromSite: FROM_SITE, fromId: BigInt(row.id),
          createTime: ts, updateTime: ts,
        },
      });
      await tx.videoInfo.create({
        data: {
          id: video.id, filepath, signature: parsed.player,
          software: parsed.program, version: parsed.version,
          noflag: parsed.noflag, board: boardWithFlags,
          board3bv: parsed.bbbv ?? 0, realTime: parsed.timeMs, noRecord,
          createTime: ts, updateTime: ts,
        },
      });
      await tx.videoStat.create({ data: { id: video.id, clicks: 0, downloads: 0, comments: 0, createTime: ts, updateTime: ts } });
      await tx.userStat.upsert({
        where: { id: BigInt(leiUid) },
        create: { id: BigInt(leiUid), createTime: ts, updateTime: ts, ...(level === "beg" ? { begVideos: 1 } : level === "int" ? { intVideos: 1 } : { expVideos: 1 }) },
        update: {
          ...(level === "beg" ? { begVideos: { increment: 1 } } : level === "int" ? { intVideos: { increment: 1 } } : { expVideos: { increment: 1 } }),
          updateTime: ts,
        },
      });
      return Number(video.id);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("SIG_TAKEN")) return { kind: "skip", reason: `标识已被他人注册 ${msg.slice(9)}` };
    return { kind: "retry", reason: `落库异常: ${msg.slice(0, 140)}` };
  }
  // ⑧ metrics/STNB 落盘 + 自动分拣（事务提交后；失败只告警，不回滚、不阻塞 cursor）
  try {
    await ensureVideoTriage(imported);
  } catch (e) {
    log(`  ! 雷网 #${imported} triage 失败需补跑: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { kind: "ok", videoId: imported, hash };
}

// ---------------- 台账／映射库：扫到即入库，终态按 ID 过滤 ----------------
const MAP_PENDING = 0;
const MAP_IMPORTED = 1;
const MAP_REJECTED = 2;
/** 临时失败重试耗尽：终态，不再下载/校验，cursor 越过该 ID */
const MAP_GAVE_UP = 3;

/** 批量取本页 video_id 的台账状态与已重试次数（一次查询，避免逐条往返） */
async function loadMapStates(ids: number[]): Promise<Map<number, { state: number; attempts: number }>> {
  if (!ids.length) return new Map();
  const rows = await prisma.openmsVideoMap.findMany({
    where: { videoId: { in: ids.map((n) => BigInt(n)) } },
    select: { videoId: true, state: true, attempts: true },
  });
  return new Map(rows.map((r) => [Number(r.videoId), { state: r.state, attempts: r.attempts }]));
}

/** 「扫到即入库」：本页新出现的 ID 一律登记为待处理；重跑绝不覆盖已有终态结论 */
async function registerScanned(rows: Row[], link: Link, seen: Map<number, { state: number; attempts: number }>) {
  if (!APPLY) return;
  const fresh = rows.filter((r) => !seen.has(r.id));
  if (!fresh.length) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.openmsVideoMap.createMany({
    data: fresh.map((r) => ({
      videoId: BigInt(r.id),
      saoleiId: BigInt(link.user),
      profile: link.profile,
      uploadTime: BigInt(r.uploadSec),
      state: MAP_PENDING,
      scanTime: now,
      updateTime: now,
    })),
    skipDuplicates: true,
  });
}

/** 落定结论：成功/明确拒收写终态；临时失败累加 attempts，超过上限落定「放弃」。
 *  返回 gaveUp=true 表示本条已耗尽重试、调用方应越过 cursor 继续往后处理。 */
async function recordMap(row: Row, link: Link, out: Outcome, attemptsBefore: number): Promise<{ gaveUp: boolean }> {
  if (!APPLY) return { gaveUp: false };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const base = {
    videoId: BigInt(row.id), saoleiId: BigInt(link.user), profile: link.profile,
    uploadTime: BigInt(row.uploadSec), scanTime: now,
  };
  if (out.kind === "retry") {
    const attempts = attemptsBefore + 1;
    // attempts=1 是首次失败；之后每次失败即一次重试，> MAX_RETRIES 时已用完 3 次重试机会
    const gaveUp = attempts > MAX_RETRIES;
    const reason = gaveUp
      ? `重试${MAX_RETRIES}次仍失败（累计${attempts}次临时失败）：${out.reason}`
      : `临时失败 ${attempts}/${MAX_RETRIES + 1}（尚可重试 ${MAX_RETRIES + 1 - attempts} 次）：${out.reason}`;
    const conclusion = {
      state: gaveUp ? MAP_GAVE_UP : MAP_PENDING,
      reason: reason.slice(0, 250),
      attempts,
      updateTime: now,
    };
    await prisma.openmsVideoMap.upsert({
      where: { videoId: BigInt(row.id) },
      create: { ...base, ...conclusion },
      update: conclusion,
    });
    return { gaveUp };
  }
  const imported = out.kind === "ok" || (out.kind === "skip" && out.importedVideoId !== undefined);
  const conclusion = {
    state: imported ? MAP_IMPORTED : MAP_REJECTED,
    reason: out.kind === "skip" && !imported ? out.reason.slice(0, 250) : null,
    importVideoId: out.kind === "ok" ? BigInt(out.videoId)
      : out.kind === "skip" && out.importedVideoId !== undefined ? BigInt(out.importedVideoId) : null,
    hash: out.kind === "ok" ? out.hash : out.kind === "skip" ? (out.hash ?? null) : null,
    updateTime: now,
  };
  await prisma.openmsVideoMap.upsert({
    where: { videoId: BigInt(row.id) },
    create: { ...base, ...conclusion },
    update: conclusion,
  });
  return { gaveUp: false };
}

// ---------------- 主流程 ----------------
async function loadLinks(): Promise<Link[]> {
  if (USERS_OVERRIDE) {
    const parsed = USERS_OVERRIDE.split(",").map((s) => {
      const [u, p] = s.split(":");
      return { user: Number(u), profile: Number(p ?? 0) };
    }).filter((l) => Number.isFinite(l.user) && l.user > 0);
    if (CURSOR_OVERRIDE !== undefined) {
      return parsed.map((l) => ({ ...l, syncCursor: Number(CURSOR_OVERRIDE) }));
    }
    // 未显式覆盖 cursor 时仍读库里已落库的进度，保证「下次以落库 ID 继续」可验证
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

async function saveCursor(user: number, cursor: number) {
  if (!APPLY) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  // updateMany：行不存在时静默 no-op（--users 调试场景），不抛 P2025 中断整轮
  await prisma.openmsLink.updateMany({
    where: { user: BigInt(user) },
    data: { syncCursor: BigInt(cursor), syncTime: now },
  });
}

// ---------------- 跑批记录：openms_sync_run（仅 --apply；dry-run 不写） ----------------
type Stats = {
  ok: number; skip: number; retry: number; gaveUp: number;
  seen: number; registered: number; pages: number; users: number;
};
type RunData = {
  status?: number;
  finishedAt?: bigint;
  users?: number; pages?: number; handled?: number; ok?: number; skip?: number;
  retry?: number; gaveUp?: number; seen?: number; registered?: number;
  currentUser?: bigint; currentProfile?: number; currentCursor?: bigint; currentVideoId?: bigint;
  lastError?: string | null;
};
let RUN_ID: bigint | null = null;

async function startRun() {
  if (!APPLY) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const run = await prisma.openmsSyncRun.create({
    data: {
      trigger: RUN_TRIGGER, status: RUN_RUNNING,
      startedAt: now, heartbeatAt: now,
      maxItems: MAX_ITEMS, pageCount: PAGE_COUNT, minGapMs: MIN_GAP_MS,
      listGapMs: LIST_MIN_GAP_MS, maxRetries: MAX_RETRIES,
    },
  });
  RUN_ID = run.id;
  log(`  run #${RUN_ID} 已登记（trigger=${RUN_TRIGGER}）`);
}

/** 心跳 + 计数/上下文写入；写失败只告警，绝不中断跑批 */
async function writeRun(data: RunData) {
  if (RUN_ID === null) return;
  try {
    await prisma.openmsSyncRun.update({
      where: { id: RUN_ID },
      data: { heartbeatAt: BigInt(Math.floor(Date.now() / 1000)), ...data },
    });
  } catch (e) {
    log(`  ! run 心跳写入失败（不影响跑批）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function endRun(status: number, s: Stats, handled: number, lastError: string | null) {
  if (RUN_ID === null) return;
  await writeRun({
    status, finishedAt: BigInt(Math.floor(Date.now() / 1000)),
    users: s.users, pages: s.pages, handled,
    ok: s.ok, skip: s.skip, retry: s.retry, gaveUp: s.gaveUp,
    seen: s.seen, registered: s.registered,
    lastError: lastError ? lastError.slice(0, 250) : null,
  });
  log(`  run #${RUN_ID} 收口 status=${status}${lastError ? ` lastError=${lastError.slice(0, 90)}` : ""}`);
  RUN_ID = null;
}

async function main() {
  const t0 = Date.now();
  log(`[openms-sync-all] start ${APPLY ? "APPLY" : "DRY-RUN"} max-items=${MAX_ITEMS} count=${PAGE_COUNT} min-gap=${MIN_GAP_MS}ms list-gap=${LIST_MIN_GAP_MS}ms max-retries=${MAX_RETRIES}`);
  log(`  list=${OPENMS_BASE}${LIST_PATH} uid-param=${UID_PARAM}(${UID_SOURCE}) cursor=inclusive(+1) download=${DOWNLOAD_PATH}`);
  await startRun();
  const stats: Stats = { ok: 0, skip: 0, retry: 0, gaveUp: 0, seen: 0, registered: 0, pages: 0, users: 0 };
  let handled = 0;
  let lastError: string | null = null;
  let currentUser = 0, currentProfile = 0, currentCursor = 0;
  let lastVideoId = 0;
  let beatCount = 0, lastBeatMs = 0, closed = false;
  /** 每 5 条或 30s 写一次心跳；force 用于页首/用户切换/收口等必须立即落点的时刻 */
  const beat = async (videoId?: number, force = false) => {
    if (RUN_ID === null) return;
    if (videoId !== undefined) lastVideoId = videoId;
    beatCount++;
    const nowMs = Date.now();
    if (!force && beatCount < RUN_HEARTBEAT_EVERY && nowMs - lastBeatMs < 30_000) return;
    beatCount = 0;
    lastBeatMs = nowMs;
    await writeRun({
      users: stats.users, pages: stats.pages, handled,
      ok: stats.ok, skip: stats.skip, retry: stats.retry, gaveUp: stats.gaveUp,
      seen: stats.seen, registered: stats.registered,
      currentUser: BigInt(currentUser), currentProfile, currentCursor: BigInt(currentCursor),
      currentVideoId: BigInt(lastVideoId),
      ...(lastError ? { lastError: lastError.slice(0, 250) } : {}),
    });
  };
  try {
    const links = await loadLinks();
    log(`  待同步用户 ${links.length} 人${USERS_OVERRIDE ? "（--users 指定）" : IGNORE_CONSENT ? "（忽略 consent）" : "（consent=1）"}`);
    if (!links.length) {
      log("[openms-sync-all] done (no user)");
      await endRun(RUN_DONE, stats, handled, null);
      closed = true;
      return;
    }
    for (const link of links) {
    if (handled >= MAX_ITEMS) break;
    stats.users++;
    const uidValue = UID_SOURCE === "profile" ? link.profile : link.user;
    if (!Number.isFinite(uidValue) || uidValue <= 0) { log(`  ! uid=${link.user} 的 ${UID_SOURCE} 无效，跳过`); continue; }
    // sync_cursor = 已处理过的最大 video_id；API cursor 是 inclusive 下界，故每次请求传 +1
    let cursor = Math.max(0, link.syncCursor);
    currentUser = link.user;
    currentProfile = link.profile;
    currentCursor = cursor;
    await beat(undefined, true);
    const startCursor = cursor;
    let stopUser = false;

    while (handled < MAX_ITEMS && !stopUser) {
      const requestCursor = cursor + 1;
      let rows: Row[];
      try {
        rows = await fetchList(requestCursor, uidValue);
      } catch (e) {
        lastError = `uid=${link.user} 列表失败: ${e instanceof Error ? e.message : String(e)}`;
        log(`  ! ${lastError}`);
        stats.retry++;
        await beat(undefined, true);
        break;
      }
      stats.pages++;
      currentCursor = requestCursor;
      if (!rows.length) { log(`  uid=${link.user} cursor=${requestCursor} 无新增`); await beat(undefined, true); break; }
      // 台账：本页先按 video_id 批量查已有结论，再把「扫到但库里没有」的 ID 全部登记入库
      const seen = await loadMapStates(rows.map((r) => r.id));
      const freshCount = rows.filter((r) => !seen.has(r.id)).length;
      await registerScanned(rows, link, seen);
      if (APPLY) stats.registered += freshCount;
      await beat(undefined, true);
      let progressed = false;
      let seenThisPage = 0;
      for (const row of rows) {
        if (handled >= MAX_ITEMS) { stopUser = true; break; }
        // 归属硬校验：saolei_id 是雷网用户 ID。profile 错配时绝不把录像挂到别人名下，
        // 直接停该用户并告警，等人工校正 openms_link.profile 后重跑（cursor 不越过该条）。
        if (row.saoleiId !== null && Number.isFinite(row.saoleiId) && row.saoleiId !== link.user) {
          lastError = `uid=${link.user} profile=${link.profile} 与返回 saolei_id=${row.saoleiId} 不一致（请校正 openms_link.profile）`;
          log(`  ! ${lastError}`);
          stats.retry++;
          stopUser = true;
          await beat(row.id, true);
          break;
        }
        const st = seen.get(row.id);
        // 「已经扫过的不重复处理」：终态（已导入/已拒收/已放弃）直接跳过，不下载、不解析、不落库，
        // 也不占 --max-items 配额；cursor 照常推进（页末/用户末统一落库）。
        if (APPLY && st !== undefined && st.state !== MAP_PENDING) {
          stats.seen++;
          seenThisPage++;
          cursor = Math.max(cursor, row.id);
          currentCursor = cursor;
          progressed = true;
          await beat(row.id);
          continue;
        }
        if (!APPLY) {
          const tag = st !== undefined && st.state !== MAP_PENDING ? `已扫过(state=${st.state})将跳过` : "待处理";
          log(`  [dry] #${row.id} ${tag} 上传于 ${new Date(row.uploadSec * 1000).toISOString()} → 用户 ${link.user}`);
          handled++;
          cursor = Math.max(cursor, row.id);
          progressed = true;
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
          const { gaveUp } = await recordMap(row, link, out, st?.attempts ?? 0);
          if (gaveUp) {
            stats.gaveUp++;
            log(`  × 开源 #${row.id} 重试 ${MAX_RETRIES} 次仍失败，落定放弃并越过: ${out.reason}`);
            // 放弃＝终态：cursor 越过该 ID 继续往后，避免一条坏录像永久卡住整条流水线
            const next = Math.max(cursor, row.id);
            if (next > cursor) { cursor = next; progressed = true; }
            await saveCursor(link.user, cursor);
            currentCursor = cursor;
            await beat(row.id, true);
            continue;
          }
          log(`  ! 开源 #${row.id} 临时失败，停止该用户本轮、cursor 不越过: ${out.reason}`);
          stopUser = true;
          break; // 不推进到该 id 之后，下轮重试
        }
        // 落定台账结论（成功/明确拒收写终态）
        await recordMap(row, link, out, st?.attempts ?? 0);
        // 每处理一条即落库 cursor（成功或永久跳过都推进，避免失败项永久卡住流水线）
        const next = Math.max(cursor, row.id);
        if (next > cursor) { cursor = next; progressed = true; }
        await saveCursor(link.user, cursor);
        currentCursor = cursor;
        await beat(row.id);
      }
      if (seenThisPage) log(`  · 本页 ${seenThisPage} 条已扫过（终态），按 ID 直接跳过`);
      // 到底 / 防死循环（每次请求已 +1，正常不会重复；仍保留护栏防对端 cursor 语义变化）
      if (stopUser) break; // 归属校验失败/临时失败导致的停止，不再打「无推进」误导日志
      if (rows.length < PAGE_COUNT) break;
      if (!progressed) { log(`  ! uid=${link.user} cursor=${requestCursor} 本页无推进，停止防死循环`); break; }
    }
    if (APPLY) await saveCursor(link.user, cursor);
    log(`  uid=${link.user} cursor ${startCursor} → ${cursor}`);
  }

  log(`[openms-sync-all] done in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `users=${stats.users} pages=${stats.pages} handled=${handled} ok=${stats.ok} skip=${stats.skip} ` +
      `retry=${stats.retry} gaveUp=${stats.gaveUp} seen=${stats.seen} registered=${stats.registered}` +
      (APPLY ? "" : "（dry-run：未下载、未落库、未登记台账、未推进 cursor、未写 run 表）"));
    // 收口前强制写一次最终上下文，否则后台「当前游标/当前录像」会停在页首
    await beat(undefined, true);
    await endRun(lastError ? RUN_PARTIAL : RUN_DONE, stats, handled, lastError);
    closed = true;
  } finally {
    // 任何未捕获异常/提前退出都把 run 标成异常终止，后台不会永远显示「运行中」
    if (!closed && RUN_ID !== null) await endRun(RUN_FAILED, stats, handled, lastError ?? "未捕获异常/提前退出");
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("[openms-sync-all] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
