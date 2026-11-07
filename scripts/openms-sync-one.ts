// 开源网（openms.top）→ 雷网 单用户历史录像同步（试跑版，2026-11-07）
//
// 用法（项目根目录）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/openms-sync-one.ts \
//     --profile 4 --uid 30872 [--limit 3] [--min-gap 12500] [--yes]
//
// 流程（与方案定案一致）：
//   query_by_id 拉全量列表（state a/c/d 才导，b 冻结 / e 外站导入盘排除）
//   → 按上传时间升序逐条：(from_site,from_id) 幂等跳过 → download（5/min 限速）
//   → md5 查重 → 上传管线同款解析校验 → 落文件 → 事务插 video(status=10,from_site,from_id)
//     /video_info/video_stat/user_stat + 称号快照 + 本BV标记
//   → ensureVideoTriage（metrics/STNB 落盘 + 自动分拣）
// 动态零写入（直插绕过 reviewVideo，不污染首页/信息流/纪录链——审核阶段才发动态）。
// 额度不计（不走原生上传计数）。

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

const OPENMS_BASE = "https://openms.top";
/** 开源扫雷网在 api_key 表的 key id（from_site 落此值；BigInt 字面量禁用→BigInt()） */
const FROM_SITE = BigInt(3);
const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const MAX_SIZE = 500 * 1024;
/** 导入的开源站 state 白名单：a=待审 c=通过 d=标识不匹配；b=冻结 / e=外站导入盘（防递归） */
const IMPORT_STATES = new Set(["a", "c", "d"]);

/**
 * 导入版本线（2026-11-07 张老师定，独立于站内上传通道的 checkProgramVersion）：
 * 只导入 Arbiter（不限版本）、元扫雷 ≥3.2.2（含）、Vienna ≥4.0.0；其余软件（Clone 等）不导入。
 * 返回 null = 通过；返回字符串 = 拒绝原因。
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
    if (verCompare(mv[1].split(".").map(Number), [3, 2, 2]) < 0) {
      return `元扫雷版本过低（${mv[1]}），导入线 3.2.2`;
    }
    return null;
  }
  if (p === "Vienna" || p === "Viennasweeper") {
    const nv = /^(\d+(?:\.\d+)*)/.exec(version.trim()); // 数字前缀：4.0.0b2→4.0.0
    if (!nv) return `无法识别 Vienna 版本（${version.trim() || "空"}），导入线 4.0.0`;
    if (verCompare(nv[1].split(".").map(Number), [4, 0, 0]) < 0) {
      return `Vienna 版本过低（${version.trim()}），导入线 4.0.0`;
    }
    return null;
  }
  return `软件不在导入范围（${p || "未知"}）`;
}

// ---------- 参数 ----------
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const profileId = parseInt(arg("profile") ?? "", 10);
const leiUid = parseInt(arg("uid") ?? "", 10);
const limit = parseInt(arg("limit") ?? "0", 10) || Infinity;
const minGapMs = parseInt(arg("min-gap") ?? "12500", 10);
const assumeYes = process.argv.includes("--yes");

if (!profileId || !leiUid) {
  console.error("用法: --profile <开源站userprofile id> --uid <雷网用户id> [--limit N] [--min-gap ms] [--yes]");
  process.exit(1);
}

// ---------- 计数 ----------
const counts: Record<string, number> = {
  total: 0, imported: 0, already: 0, md5Hit: 0, stateSkip: 0,
  parse: 0, version: 0, ext: 0, levelMode: 0, phone: 0, incomplete: 0,
  software: 0, sensitive: 0, sigTaken: 0, size: 0, error: 0,
};
const skipDetail: { id: number; reason: string; info?: string }[] = [];

function log(line: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      if (res.status === 429 && attempt < 2) {
        log(`  429 限速，等 25s 重试`);
        await new Promise((r) => setTimeout(r, 25_000));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function main() {
  // 不同意名单跳过（2026-11-07 张老师需求：openms_link.consent=2 的用户不同步）
  const link = await prisma.openmsLink.findUnique({
    where: { user: BigInt(leiUid) },
    select: { consent: true },
  });
  if (link?.consent === 2) {
    log(`用户 ${leiUid} 已表态不同意同步，跳过`);
    return;
  }
  log(`拉取开源站用户目录 profile=${profileId}（雷网 uid=${leiUid}）`);
  const listRes = await fetchWithRetry(`${OPENMS_BASE}/api/video/query_by_id?id=${profileId}`);
  if (!listRes.ok) {
    console.error(`query_by_id 失败 HTTP ${listRes.status}`);
    process.exit(1);
  }
  const all: {
    id: number; upload_time: string; level: string; mode: string; state: string;
    software: string; timems: number; bv: number;
  }[] = await listRes.json();
  counts.total = all.length;

  const importable = all
    .filter((v) => (IMPORT_STATES.has(v.state) ? true : (counts.stateSkip++, skipDetail.push({ id: v.id, reason: `state=${v.state}` }), false)))
    .sort((a, b) => new Date(a.upload_time).getTime() - new Date(b.upload_time).getTime())
    .slice(0, limit === Infinity ? undefined : limit);

  log(`总量 ${all.length}，可导入 ${importable.length}（state 排除 ${counts.stateSkip}）${limit !== Infinity ? `【本次限 ${limit} 条试跑】` : ""}`);
  if (!assumeYes) {
    log("预览模式（不加 --yes 不落库）。前 5 条：");
    for (const v of importable.slice(0, 5)) log(`  #${v.id} ${v.upload_time} state=${v.state} software=${v.software} ${v.timems}ms bv=${v.bv}`);
    return;
  }

  let lastDownloadAt = 0;
  for (const v of importable) {
    try {
      // ① 幂等：已导入过
      const dup = await prisma.video.findFirst({ where: { fromSite: FROM_SITE, fromId: BigInt(v.id) }, select: { id: true } });
      if (dup) { counts.already++; continue; }

      // ② 下载（严格限速：距上次下载 ≥minGapMs）
      const wait = minGapMs - (Date.now() - lastDownloadAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastDownloadAt = Date.now();
      const dl = await fetchWithRetry(`${OPENMS_BASE}/api/video/download/${v.id}`);
      if (!dl.ok) { counts.error++; skipDetail.push({ id: v.id, reason: `download HTTP ${dl.status}` }); continue; }
      const buf = Buffer.from(await dl.arrayBuffer());
      // 原始后缀：Content-Disposition filename（URI 编码）
      const cd = dl.headers.get("content-disposition") ?? "";
      const m = cd.match(/filename="([^"]+)"/);
      let ext = m ? path.extname(decodeURIComponent(m[1])).slice(1).toLowerCase() : "";
      if (!["mvf", "avf", "evf"].includes(ext)) {
        // 后缀异常时按开源站 software 枚举兜底（a=avf e=evf m=mvf）
        ext = v.software === "a" ? "avf" : v.software === "e" ? "evf" : v.software === "m" ? "mvf" : "";
      }
      if (!["mvf", "avf", "evf"].includes(ext)) { counts.ext++; skipDetail.push({ id: v.id, reason: `ext=${ext || v.software}` }); continue; }
      if (buf.length > MAX_SIZE) { counts.size++; skipDetail.push({ id: v.id, reason: "size>500KB" }); continue; }

      // ③ md5 查重
      const hash = createHash("md5").update(buf).digest("hex");
      const md5Dup = await prisma.video.findFirst({ where: { hash }, select: { id: true } });
      if (md5Dup) { counts.md5Hit++; skipDetail.push({ id: v.id, reason: "md5 雷网已有", info: `leiwang#${md5Dup.id}` }); continue; }

      // ④ 解析 + 上传管线同款校验（失败跳过不阻塞，试跑期全部留痕）
      let lines: string[] | null = null;
      try {
        lines = ext === "avf" ? avfToRawvf(buf) : ext === "evf" ? evfToRawvf(buf) : (mvfToRawvfBest(buf)?.lines ?? null);
      } catch { /* parse null */ }
      if (!lines) { counts.parse++; skipDetail.push({ id: v.id, reason: "解析失败" }); continue; }
      const parsed = formatRawvf(lines);
      if (parsed.version === "<=0.96") { counts.version++; skipDetail.push({ id: v.id, reason: "版本<=0.96" }); continue; }
      // 导入版本线（张老师 2026-11-07：Arbiter 不限 / 元扫雷≥3.2.2 / Vienna≥4.0.0），非上传通道线
      const tooOld = checkImportVersion(parsed.program, parsed.version);
      if (tooOld) { counts.version++; skipDetail.push({ id: v.id, reason: tooOld }); continue; }
      if (parsed.program.includes(ONLINE_PROGRAM_MARKER)) { counts.software++; skipDetail.push({ id: v.id, reason: "在线玩录像" }); continue; }
      if (parsed.program === RANKED_SOFTWARE) { counts.software++; skipDetail.push({ id: v.id, reason: "排名软件" }); continue; }
      if (!(parsed.level in LEVEL_MIN_3BV)) { counts.levelMode++; skipDetail.push({ id: v.id, reason: `level=${parsed.level}` }); continue; }
      if (parsed.mode !== "classic") { counts.levelMode++; skipDetail.push({ id: v.id, reason: `mode=${parsed.mode}` }); continue; }
      if (!parsed.events.some((l) => /^[-\d.]+ mv /.test(l))) { counts.phone++; skipDetail.push({ id: v.id, reason: "手机录像(无mv)" }); continue; }
      if (parsed.solved3bv !== null) {
        if (parsed.solved3bv < (parsed.bbbv ?? 0)) { counts.incomplete++; skipDetail.push({ id: v.id, reason: "未完成(solved3bv)" }); continue; }
      } else {
        const outcome = judgeVideoOutcome(parsed);
        if (outcome !== "win") { counts.incomplete++; skipDetail.push({ id: v.id, reason: `未完成(${outcome})` }); continue; }
      }
      const level = parsed.level as VideoLevel;
      const noRecord = (parsed.bbbv ?? 0) < LEVEL_MIN_3BV[level];

      // 敏感词标识
      const sigHit = checkSensitive(parsed.player);
      if (!sigHit.ok) { counts.sensitive++; skipDetail.push({ id: v.id, reason: "敏感词标识" }); continue; }

      // ⑤ 落文件（目录按上传时间 +08:00 日期）
      const uploadSec = Math.floor(new Date(v.upload_time).getTime() / 1000);
      const d = new Date((uploadSec + 28800) * 1000);
      const dir = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      const filepath = `/${dir}/${hash}.${ext}`;
      const absDir = path.join(VIDEOS_ROOT, dir);
      if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
      writeFileSync(path.join(absDir, `${hash}.${ext}`), buf);

      // ⑥ 事务落库（镜像上传路由：签名/快照/本BV/四表）
      const ts = BigInt(uploadSec);
      const imported = await prisma.$transaction(async (tx) => {
        const sig = await tx.userSig.findFirst({ where: { signature: parsed.player } });
        if (sig && Number(sig.user) !== leiUid) throw new Error(`SIG_TAKEN:${sig.user}`);
        if (!sig) {
          await tx.userSig.create({ data: { user: BigInt(leiUid), signature: parsed.player, createTime: ts } });
        }
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
            fromSite: FROM_SITE, fromId: BigInt(v.id),
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
      counts.imported++;
      // ⑦ metrics/STNB 落盘 + 自动分拣（事务提交后）
      await ensureVideoTriage(imported);
      log(`  ✓ #${v.id} → 雷网 #${imported} ${level} ${parsed.timeMs}ms 3bv=${parsed.bbbv}${noRecord ? " [运气盘]" : ""}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("SIG_TAKEN")) { counts.sigTaken++; skipDetail.push({ id: v.id, reason: "标识已被他人注册", info: msg }); }
      else { counts.error++; skipDetail.push({ id: v.id, reason: `异常: ${msg.slice(0, 120)}` }); log(`  ✗ #${v.id} ${msg.slice(0, 160)}`); }
    }
  }

  // ---------- 汇总 ----------
  log("========== 汇总 ==========");
  for (const [k, n] of Object.entries(counts)) if (n) log(`  ${k}: ${n}`);
  if (skipDetail.length) {
    log("跳过明细：");
    for (const s of skipDetail) log(`  #${s.id} ${s.reason}${s.info ? ` (${s.info})` : ""}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
