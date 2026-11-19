// 存量修复（2026-11-12 张老师指令）：fc66080（btn 键态纠偏）与 ac43f96（孤 lr
// 合成 lc）互相踩脚——lr 自带 btn=0 先被纠偏清 lp，孤 lr 判定的 wasLp 快照恒
// false，每次正常单击开格都被误判成孤 lr，服务端在流内 splice 合成与 lr 同坐标
// 同毫秒的假 lc。导出原始事件流后，回放/分析端左键按压时长全显 0ms（实测
// 358883：41 对假 lc ↔ 41 个无配对真 lc）。权威侧已修（core 903d209，纠偏只在
// seq 跳号＝真丢事件时启用），本脚本清洗 11-10 14:50（fc66080 上线）起生成的
// 全部受污染排行 EVF。
//
// 剔除判据＝flop 键态机扫描：流内 lp（左键按住）已置位时再次出现的 lc ＝ 冗余
// 合成（真按压未闭合不可能有第二次按下）→ 剔除。三类场景天然区分：
// ①误伤合成（真 lc 未闭合 + 假 lc）→ lp=true 遇 lc → 剔 ✓
// ②合法合成（354987 真丢 lc，服务端补合成）→ lc 时 lp=false → 保留 ✓
// ③连击模式真实 lc+lr 对（按下即录）→ 每对 lp 已闭合 → 保留 ✓
// 剔除后做终态等价校验（原流 vs 剔后流重放终盘一致），不等即拒绝该条 fail closed。
// 重编码走排名上传同管线（buildRankedEvf v4，含 evf-export-guard 导出闸门）：
// 改名换 hash、evf_sig 重签、旧文件删除；Video.hash 同步更新（10-28 铁律）。
// metrics 由 video-metrics --ids-file 定点重算（按压时长类统计）。
//
// 用法（生产机 /home/deploy/saolei.wang，需先载入 .env 的 AUTH_SECRET/DATABASE_URL）：
//   set -a && source .env && set +a
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/fix-synth-lc.ts --scan
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/fix-synth-lc.ts \
//     --ids-file=/tmp/synth-lc-ids.txt [--dry] [--since=epoch秒]
//
// 幂等：剔 0 条即跳过（产物字节与原文件一致也会因 hash 相同自然跳过）；
// DB 更新失败不删旧文件。
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { prisma } from "../src/lib/db";
import { parseEvf } from "../src/lib/evf";
import { buildRankedEvf, RANKED_SOFTWARE } from "../src/lib/evfwrite";
import { evfSignature } from "../src/core/src/lib/evf-sign";

const arg = (name: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const DRY = process.argv.includes("--dry");
const SCAN = process.argv.includes("--scan");
const SINCE = Number(arg("since") ?? 0);
const REPO = process.cwd();
const VIDEOS = path.join(REPO, "videos");

/** evf 事件名 → OnlineEvent 码（buildRankedEvf 输入口径，AVF 位掩码） */
const NAME2ONLINE: Record<string, number> = { mv: 1, lc: 3, lr: 5, rc: 9, rr: 17, mc: 33, mr: 65, cc: 11 };

interface EvfEv { mouse?: string; time: number; x?: number; y?: number }

/** 键态机扫描：标记「冗余合成 lc」的下标集合（lp 已置位时的 lc） */
function findSyntheticLc(events: EvfEv[]): number[] {
  const fake: number[] = [];
  let lp = false, rp = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.mouse) continue; // pause 等非 mouse 事件不动键态
    switch (e.mouse) {
      case "lc": if (lp) fake.push(i); else lp = true; break;
      case "rc": if (rp) fake.push(i); else rp = true; break; // 对称防御：本 bug 理论上不产冗余 rc，出现即剔除（重放校验兜底）
      case "lr": lp = false; break;
      case "rr": rp = false; break;
      case "cc": lp = true; break; // 双击按下（flop readevf 消歧：cc＝双键按下）
    }
  }
  return fake;
}

/** flop 语义重放，返回终盘状态串（开格=数字、旗、未开），用于终态等价校验 */
function replayFinalState(v: ReturnType<typeof parseEvf>): string {
  const rows = v.height, cols = v.width, N = rows * cols;
  const boardStr = v.board;
  const mines = new Uint8Array(N), nums = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = boardStr[i];
    if (c === "*") mines[i] = 1; else nums[i] = c.charCodeAt(0) - 48;
  }
  const state = new Uint8Array(N); // 0 未开 1 已开 2 旗
  const cell = (x?: number, y?: number) => (x == null || y == null) ? -1 : ((y / v.cellPixelSize) | 0) * cols + ((x / v.cellPixelSize) | 0);
  const open = (idx: number) => {
    if (idx < 0 || idx >= N || state[idx] !== 0 || mines[idx]) return;
    state[idx] = 1;
    if (nums[idx] === 0) {
      const cx = idx % cols, cy = (idx / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) open(ny * cols + nx);
      }
    }
  };
  const toggle = (idx: number) => {
    if (idx < 0 || idx >= N || state[idx] === 1) return;
    state[idx] = state[idx] === 2 ? 0 : 2;
  };
  const openAround = (idx: number) => {
    if (idx < 0 || idx >= N) return;
    if (nums[idx] === 0) return;
    const cx = idx % cols, cy = (idx / cols) | 0;
    let flags = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if ((dx || dy) && nx >= 0 && nx < cols && ny >= 0 && ny < rows && state[ny * cols + nx] === 2) flags++;
    }
    if (flags !== nums[idx]) return;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if ((dx || dy) && nx >= 0 && nx < cols && ny >= 0 && ny < rows) open(ny * cols + nx);
    }
  };
  let lp = false, rp = false, sv = -1;
  for (const e of v.events as EvfEv[]) {
    if (!e.mouse) continue;
    const idx = cell(e.x, e.y);
    switch (e.mouse) {
      case "lc": lp = true; break;
      case "rc": if (!lp) toggle(idx); rp = true; break;
      case "cc": lp = true; sv = idx; break;
      case "lr":
        if (rp || sv >= 0) openAround(idx);
        else if (lp) open(idx);
        lp = false; sv = -1; break;
      case "rr": if (lp) openAround(idx); rp = false; break;
      case "mr": openAround(idx); break;
    }
  }
  return Array.from(state).join(",");
}

/** 剔除下标集合后的事件转 OnlineEvent（buildRankedEvf 输入口径） */
function toOnlineEvents(v: ReturnType<typeof parseEvf>, drop: Set<number>) {
  const out: { mouse: number; sec: number; hun: number; ms: number; x: number; y: number }[] = [];
  let stray = 0;
  for (let i = 0; i < v.events.length; i++) {
    if (drop.has(i)) continue;
    const e = v.events[i] as EvfEv;
    if (!e.mouse) { if (!("pause" in e)) stray++; continue; }
    const code = NAME2ONLINE[e.mouse];
    if (code === undefined) throw new Error(`未支持的事件类型 ${e.mouse}（idx=${i}）`);
    const ms = Math.round(e.time * 1000);
    out.push({ mouse: code, sec: Math.floor(ms / 1000), hun: Math.floor((ms % 1000) / 10), ms, x: e.x!, y: e.y! });
  }
  return { out, stray };
}

async function loadIds(): Promise<{ id: bigint; filepath: string }[]> {
  const idsFile = arg("ids-file");
  const idsArg = arg("ids");
  if (idsFile || idsArg) {
    const ids = (idsFile ? readFileSync(idsFile!, "utf8") : (idsArg ?? ""))
      .split(/\s+/).map((s) => s.trim()).filter(Boolean).map(Number);
    const out: { id: bigint; filepath: string }[] = [];
    for (const id of ids) {
      const info = await prisma.videoInfo.findUnique({
        where: { id: BigInt(id) }, select: { id: true, filepath: true },
      });
      if (info?.filepath) out.push(info);
    }
    return out;
  }
  // 默认：SINCE 之后的本站排名 EVF（fc66080 上线窗起）
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; filepath: string }[]>(
    `SELECT v.id, vi.filepath FROM video v JOIN video_info vi ON v.id = vi.id
     WHERE vi.software = 'Saolei.wang' AND v.ranked = 1 AND v.create_time > ? ORDER BY v.id ASC`,
    SINCE,
  );
  return rows.map((r) => ({ id: BigInt(r.id), filepath: r.filepath }));
}

async function main() {
  // --file= 单文件模式：不碰库，只解析剔除并重编码验证（人工核查单条用）
  const file = arg("file");
  if (file) {
    const oldBuf = readFileSync(file);
    const v = parseEvf(new Uint8Array(oldBuf));
    const fake = findSyntheticLc(v.events as EvfEv[]);
    console.log(`冗余合成 lc：${fake.length} 个`);
    fake.forEach((i) => {
      const e = v.events[i] as EvfEv;
      console.log(`  idx=${i} t=${(e.time * 1000).toFixed(0)}ms (${e.x},${e.y}) 下一事件=${v.events[i + 1]?.mouse}@${(v.events[i + 1]?.time ?? 0) * 1000 | 0}ms`);
    });
    if (fake.length === 0) return;
    const before = replayFinalState(v);
    const drop = new Set(fake);
    const { out: keptEvents } = toOnlineEvents(v, drop);
    const board = new Uint8Array(v.width * v.height);
    const gridStr = v.grid.join("");
    for (let i = 0; i < board.length; i++) board[i] = gridStr[i] === "*" ? 1 : 0;
    const evf = buildRankedEvf({
      width: v.width, height: v.height, mines: v.mines, board,
      questionMarks: v.useQuestion, nf: v.nf, bbbv: v.bbbv,
      scoreCsec: Math.round(v.rtimeMs / 10), scoreMs: v.rtimeMs,
      events: keptEvents, player: v.playerIdentifier,
      uniqueIdentifier: v.uniqueIdentifier, won: v.isCompleted || undefined,
      clientVersion: v.software.startsWith(`${RANKED_SOFTWARE} `) ? v.software.slice(RANKED_SOFTWARE.length + 1) : undefined,
      startedAtMs: v.startTime != null ? v.startTime / 1000 : undefined,
      endedAtMs: v.endTime != null ? v.endTime / 1000 : undefined,
      validationEvents: keptEvents,
    });
    const nv = parseEvf(new Uint8Array(Buffer.from(evf)));
    console.log(`终态等价：${replayFinalState(nv) === before ? "✓" : "✗ 不等价"}`);
    console.log(`产物冗余 lc：${findSyntheticLc(nv.events as EvfEv[]).length}（应为 0）`);
    const out = arg("out");
    if (out) { writeFileSync(out, Buffer.from(evf)); console.log(`已写出 ${out}（${Buffer.from(evf).length}B）`); }
    return;
  }
  const rows = await loadIds();
  console.log(`待处理 ${rows.length} 条${DRY ? "（dry-run）" : ""}${SCAN ? "（scan）" : ""}${SINCE ? `（since=${SINCE}）` : ""}`);

  let affected = 0, fixed = 0, skipped = 0, failed = 0;
  const affectedIds: number[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    try {
      const oldPath = path.join(VIDEOS, row.filepath.replace(/^\//, ""));
      if (!existsSync(oldPath)) { console.log(`SKIP ${id}: 文件不存在 ${row.filepath}`); skipped++; continue; }
      const oldBuf = readFileSync(oldPath);
      const v = parseEvf(new Uint8Array(oldBuf));

      const fake = findSyntheticLc(v.events as EvfEv[]);
      if (fake.length === 0) { skipped++; continue; }
      affected++;
      affectedIds.push(id);
      if (SCAN || DRY) {
        console.log(`AFFECT ${id}: 冗余lc=${fake.length} 文件=${row.filepath}`);
        if (SCAN) continue;
      }
      if (SCAN) continue;

      // —— 剔除 + 终态等价校验 ——
      const drop = new Set(fake);
      const before = replayFinalState(v);
      const kept = v.events.filter((_, i) => !drop.has(i));
      const afterV = { ...v, events: kept } as typeof v;
      const after = replayFinalState(afterV);
      if (before !== after) throw new Error(`终态不等价（冗余 lc 剔除改变终盘），人工核查`);

      if (v.cellPixelSize !== 16) throw new Error(`cellPixelSize=${v.cellPixelSize} 非 16，人工核查`);
      const { out: keptEvents, stray } = toOnlineEvents(v, drop);
      if (stray > 0) throw new Error(`含 ${stray} 个非鼠标事件，人工核查`);
      const software = v.software;
      if (software !== RANKED_SOFTWARE && !software.startsWith(`${RANKED_SOFTWARE} `)) {
        throw new Error(`software=${software} 非本站排名局`);
      }
      const clientVersion = software.startsWith(`${RANKED_SOFTWARE} `)
        ? software.slice(RANKED_SOFTWARE.length + 1) : undefined;
      const board = new Uint8Array(v.width * v.height);
      const gridStr = v.grid.join("");
      for (let i = 0; i < board.length; i++) board[i] = gridStr[i] === "*" ? 1 : 0;
      const evf = buildRankedEvf({
        width: v.width, height: v.height, mines: v.mines, board,
        questionMarks: v.useQuestion, nf: v.nf, bbbv: v.bbbv,
        scoreCsec: Math.round(v.rtimeMs / 10), scoreMs: v.rtimeMs,
        events: keptEvents, player: v.playerIdentifier,
        uniqueIdentifier: v.uniqueIdentifier, won: v.isCompleted || undefined,
        clientVersion,
        startedAtMs: v.startTime != null ? v.startTime / 1000 : undefined,
        endedAtMs: v.endTime != null ? v.endTime / 1000 : undefined,
        validationEvents: keptEvents,
      });
      const newBuf = Buffer.from(evf);

      // 产物自校验：键态机再扫无冗余 lc；重放终态与原文件一致
      const nv = parseEvf(new Uint8Array(newBuf));
      if (findSyntheticLc(nv.events as EvfEv[]).length !== 0) throw new Error(`产物仍含冗余 lc`);
      if (replayFinalState(nv) !== before) throw new Error(`产物终态与原文件不等价`);

      const video = await prisma.video.findUnique({ where: { id: row.id }, select: { createTime: true } });
      if (!video) throw new Error("video 行缺失");
      const t = new Date(Number(video.createTime) * 1000);
      const dir = `/${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
      const hash = createHash("md5").update(newBuf).digest("hex");
      const newFilepath = `${dir}/${hash}.evf`;
      const newDiskPath = path.join(VIDEOS, newFilepath.replace(/^\//, ""));
      console.log(`FIX ${id}: ${row.filepath} -> ${newFilepath} (${oldBuf.length}B -> ${newBuf.length}B, 剔除冗余lc=${fake.length})`);
      if (DRY) continue;
      mkdirSync(path.dirname(newDiskPath), { recursive: true });
      writeFileSync(newDiskPath, newBuf);
      await prisma.$transaction([
        prisma.videoInfo.update({
          where: { id: row.id },
          data: { filepath: newFilepath, evfSig: evfSignature(new Uint8Array(newBuf)) },
        }),
        prisma.video.update({
          where: { id: row.id },
          data: { hash },
        }),
      ]);
      if (newDiskPath !== oldPath) unlinkSync(oldPath);
      fixed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`完成：受影响 ${affected}，修复 ${fixed}，跳过 ${skipped}，失败 ${failed}`);
  if (affectedIds.length) console.log(`受影响清单：\n${affectedIds.join("\n")}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
