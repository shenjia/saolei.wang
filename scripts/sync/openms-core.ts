// 开源扫雷网 → 雷网 同步：扫描器 / 下载器共享核心（2026-11-17 拆分为两脚本）
//
// 【为什么要拆】（张老师 2026-11-17 定）
//   单脚本串行遍历用户时，大积压用户会把整轮下载配额吃光，排在后面的用户连列表都拉不到，
//   新上传的录像要等队头几千盘清完才被扫到 → 新内容延迟可达一天。
//   拆开后：
//     openms-scan.ts     —— 只碰列表 API（1 次/2s），每轮穿越**全部** consent=1 用户，
//                           「扫到即入库」登记台账 state=0，独占 openms_link.sync_cursor。
//     openms-download.ts —— 只碰下载 API，消费台账 state=0 队列（FIFO），
//                           间隔 12.5s 连续下载 = 4.8 盘/分，永不空转也不会超对方 5/分限速。
//   扫描与下载互不阻塞：新盘当轮就进队列，下载器按上传时间从老到新连续清队。
//
// 【台账 openms_video_map】（2026-11-10 张老师定）
//   「扫到的录像都入库，不管有没有同步、这边接不接受」——注册即 state=0；
//   下载后落定 1=已导入 2=明确拒收 3=重试耗尽放弃；临时失败保持 0 并累加 attempts。
//   本模块只负责登记与结论落库，配额/限速策略由各脚本自己掌握。
//
// 【跑批记录 openms_sync_run】
//   trigger 字段区分 'scan' / 'download'（后台状态卡按此分栏展示）；
//   每轮 --apply 写一行：启动 insert、处理中按心跳更新、收口写 finished_at + status。
//   dry-run 不写，避免测试污染历史。

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

// ---------------- 配置区（env 覆盖便于联调/灰度） ----------------
const env = (k: string, d: string) => process.env[k] ?? d;
export const OPENMS_BASE = env("OPENMS_BASE", "https://openms.top");
/** 未映射录像列表接口（对方 2026-11-10 定稿） */
export const LIST_PATH = env("OPENMS_LIST_PATH", "/api/accountlink/saolei/unmapped_videos");
/** 原文件下载路径，{id} 为 video_id；响应 Content-Disposition 保留原软件后缀 */
export const DOWNLOAD_PATH = env("OPENMS_DOWNLOAD_PATH", "/api/video/download/{id}");
/** 用户过滤参数名：值是开源站本地 UserProfile.id，不是雷网 uid */
export const UID_PARAM = env("OPENMS_UID_PARAM", "user_id");
/** 该参数传开源站 profile（= openms_link.profile）；lei=雷网 uid（联调排障用） */
export const UID_SOURCE = env("OPENMS_UID_SOURCE", "profile");
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

/** 运行参数（由各脚本在启动时按 CLI 覆盖） */
export const cfg = {
  /** 两次下载最小间隔（对方限速 5 盘/分 → 12.5s；脚本内连续跑时即 4.8 盘/分） */
  downloadGapMs: 12_500,
  /** 两次列表请求最小间隔（对方限速 1 次/2s） */
  listGapMs: 2_100,
  /** 临时故障（429/5xx/网络异常）重试退避 */
  retryWaitMs: 25_000,
  /** 首次临时失败后允许的跨轮重试次数；累计 (1+maxRetries) 次失败即落定放弃 */
  maxRetries: 3,
};

// ---------------- 工具 ----------------
export function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

export function log(line: string) {
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
        log(`  HTTP ${res.status}，等 ${cfg.retryWaitMs}ms 重试 (${url.split("?")[0]})`);
        await new Promise((r) => setTimeout(r, cfg.retryWaitMs));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, cfg.retryWaitMs));
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
export type Row = { id: number; uploadSec: number; saoleiId: number | null };
export type Link = { user: number; profile: number; syncCursor: number };
export type Outcome =
  | { kind: "ok"; videoId: number; hash: string }
  | { kind: "skip"; reason: string; importedVideoId?: number; hash?: string }
  | { kind: "retry"; reason: string };

// ---------------- 列表 API（仅扫描器调用） ----------------
let lastListAt = 0;
/** cursor 原样传给 API（inclusive 下界）；调用方负责传「已扫描最大 id + 1」 */
export async function fetchList(cursor: number, uidValue: number, count: number): Promise<Row[]> {
  const wait = cfg.listGapMs - (Date.now() - lastListAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastListAt = Date.now();
  const url = new URL(LIST_PATH, OPENMS_BASE);
  url.searchParams.set("cursor", String(cursor));
  url.searchParams.set("count", String(count));
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

// ---------------- 单盘下载导入（仅下载器调用） ----------------
let lastDownloadAt = 0;

/** 距上次下载补足间隔：脚本内连续下载严格 12.5s 一条，不做任何加速 */
async function downloadGate() {
  const wait = cfg.downloadGapMs - (Date.now() - lastDownloadAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDownloadAt = Date.now();
}

/**
 * 下载 + 解析 + 上传管线同款校验 + 落文件 + 事务落库（status=10 待审）。
 * 纯函数式返回结论，台账/游标由调用方落定。
 */
export async function importOne(row: Row, leiUid: number): Promise<Outcome> {
  // ① 幂等：本站已导入过该开源站录像
  const dup = await prisma.video.findFirst({
    where: { fromSite: FROM_SITE, fromId: BigInt(row.id) },
    select: { id: true },
  });
  if (dup) return { kind: "skip", reason: "已导入", importedVideoId: Number(dup.id) };

  // ② 限速下载（距上次下载 ≥ cfg.downloadGapMs，默认 5 次/分钟）
  await downloadGate();
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
  // 比赛标识（2026-11-14 张老师需求）：会公开展示，同过前置词库
  if (parsed.race) {
    const raceHit = checkSensitive(parsed.race);
    if (!raceHit.ok) return { kind: "skip", reason: "敏感词比赛标识" };
  }

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
          // 比赛标识（2026-11-14 张老师需求）：文件内嵌赛事字段原样落库；无则不写
          ...(parsed.race ? { race: parsed.race } : {}),
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
  // ⑧ metrics/STNB 落盘 + 自动分拣（事务提交后；失败只告警，不回滚）
  try {
    await ensureVideoTriage(imported);
  } catch (e) {
    log(`  ! 雷网 #${imported} triage 失败需补跑: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { kind: "ok", videoId: imported, hash };
}

// ---------------- 台账：扫到即入库，终态按 ID 过滤 ----------------
export const MAP_PENDING = 0;
export const MAP_IMPORTED = 1;
export const MAP_REJECTED = 2;
/** 临时失败重试耗尽：终态，不再下载/校验 */
export const MAP_GAVE_UP = 3;

/**
 * 「扫到即入库」：把本页新出现的 ID 登记为待处理；已存在行（任何状态）绝不覆盖。
 * 返回本页新增 / 已存在条数，供扫描器统计。
 */
export async function registerScanned(
  rows: Row[],
  link: { user: number; profile: number },
): Promise<{ fresh: number; seen: number }> {
  if (!rows.length) return { fresh: 0, seen: 0 };
  const existing = await prisma.openmsVideoMap.findMany({
    where: { videoId: { in: rows.map((r) => BigInt(r.id)) } },
    select: { videoId: true },
  });
  const have = new Set(existing.map((e) => Number(e.videoId)));
  const fresh = rows.filter((r) => !have.has(r.id));
  if (fresh.length) {
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
  return { fresh: fresh.length, seen: rows.length - fresh.length };
}

/** 落定结论：成功/明确拒收写终态；临时失败累加 attempts，超过上限落定「放弃」。
 *  返回 gaveUp=true 表示本条已耗尽重试。 */
export async function recordMap(
  row: Row,
  link: { user: number; profile: number },
  out: Outcome,
  attemptsBefore: number,
): Promise<{ gaveUp: boolean }> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const base = {
    videoId: BigInt(row.id), saoleiId: BigInt(link.user), profile: link.profile,
    uploadTime: BigInt(row.uploadSec), scanTime: now,
  };
  if (out.kind === "retry") {
    const attempts = attemptsBefore + 1;
    // attempts=1 是首次失败；之后每次失败即一次重试，> maxRetries 时已用完重试机会
    const gaveUp = attempts > cfg.maxRetries;
    const reason = gaveUp
      ? `重试${cfg.maxRetries}次仍失败（累计${attempts}次临时失败）：${out.reason}`
      : `临时失败 ${attempts}/${cfg.maxRetries + 1}（尚可重试 ${cfg.maxRetries + 1 - attempts} 次）：${out.reason}`;
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

// ---------------- 游标（仅扫描器持有） ----------------
export async function saveCursor(user: number, cursor: number) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  // updateMany：行不存在时静默 no-op（--users 调试场景），不抛 P2025 中断整轮
  await prisma.openmsLink.updateMany({
    where: { user: BigInt(user) },
    data: { syncCursor: BigInt(cursor), syncTime: now },
  });
}

// ---------------- 跑批记录：openms_sync_run（仅 --apply；dry-run 不写） ----------------
export const RUN_RUNNING = 0, RUN_DONE = 1, RUN_PARTIAL = 2, RUN_FAILED = 3;

export type RunSnapshot = {
  maxItems: number;
  pageCount: number;
  minGapMs: number;
  listGapMs: number;
  maxRetries: number;
};

export type RunPatch = {
  status?: number;
  finishedAt?: bigint;
  users?: number; pages?: number; handled?: number; ok?: number; skip?: number;
  retry?: number; gaveUp?: number; seen?: number; registered?: number;
  currentUser?: bigint; currentProfile?: number; currentCursor?: bigint; currentVideoId?: bigint;
  lastError?: string | null;
};

let RUN_ID: bigint | null = null;

export function runId(): bigint | null {
  return RUN_ID;
}

export async function startRun(trigger: string, snap: RunSnapshot, apply: boolean) {
  if (!apply) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const run = await prisma.openmsSyncRun.create({
    data: {
      trigger, status: RUN_RUNNING,
      startedAt: now, heartbeatAt: now,
      maxItems: snap.maxItems, pageCount: snap.pageCount, minGapMs: snap.minGapMs,
      listGapMs: snap.listGapMs, maxRetries: snap.maxRetries,
    },
  });
  RUN_ID = run.id;
  log(`  run #${RUN_ID} 已登记（trigger=${trigger}）`);
}

/** 心跳 + 计数/上下文写入；写失败只告警，绝不中断跑批 */
export async function writeRun(data: RunPatch) {
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

export async function endRun(status: number, data: RunPatch, lastError: string | null) {
  if (RUN_ID === null) return;
  await writeRun({
    ...data,
    status,
    finishedAt: BigInt(Math.floor(Date.now() / 1000)),
    lastError: lastError ? lastError.slice(0, 250) : null,
  });
  log(`  run #${RUN_ID} 收口 status=${status}${lastError ? ` lastError=${lastError.slice(0, 90)}` : ""}`);
  RUN_ID = null;
}

/** 收尾：未捕获异常/提前退出时把 run 标成异常终止，后台不会永远显示「运行中」 */
export async function finishOnError(lastError: string | null) {
  if (RUN_ID !== null) await endRun(RUN_FAILED, {}, lastError ?? "未捕获异常/提前退出");
  await prisma.$disconnect();
}
