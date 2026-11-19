// 存量修复（2026-11-06，张老师定）：排名 EVF 导出链在 2026-10-27（排名模式 init）至
// 2026-11-06 decaaa8 部署之间恒过 repairWinningEvents 补洞——其模拟器不识双键 chord
//（按住左键的 rc 被当插旗、rr-chord 零模拟），把 chord 开掉的格子误判为洞，在事件流
// 末尾按格心坐标追加成对合成点击（353971 案 194 个合成事件，回放观感「终局光标乱扫」）。
// 实证：原生事件流在 flop 语义下重放恰在胜局事件处精确到达终盘（216/216），合成段
// 纯属胜局后的无效尾巴。
// 本脚本以「flop 语义重放首次达成胜局的事件」为终点，剥离其后全部事件并按排名上传
// 同管线（buildRankedEvf，v4）重编码：改名换 hash、evf_sig 重签、旧文件删除；
// metrics 由 video-metrics --ids-file 定点重算。与 repair-ghost-lr.ts（快照重导）
// 互补：快照缺失（>7 天）的存量用本脚本；快照在的优先 repair-ghost-lr（可顺带清理
// canonicalize 时代的中段伪 lc+lr）。播放端配套口径（张老师定）：录像播放以胜局
// 事件为终点，剩余雷由前端补显，不依赖事件流里的合成点击。
//
// 用法（生产机 /home/deploy/saolei.wang，需先载入 .env 的 AUTH_SECRET/DATABASE_URL）：
//   set -a && source .env && set +a
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/strip-win-tail.ts --scan
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/strip-win-tail.ts \
//     --ids-file=/tmp/win-tail-ids.txt [--dry]
//
// 幂等：tail=0 即跳过；DB 更新失败不删旧文件。
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
const REPO = process.cwd();
const VIDEOS = path.join(REPO, "videos");

/** evf 事件名 → OnlineEvent 码（buildRankedEvf 输入口径，AVF 位掩码） */
const NAME2ONLINE: Record<string, number> = { mv: 1, lc: 3, lr: 5, rc: 9, rr: 17, mc: 33, mr: 65, cc: 11 };

interface ReplayResult {
  win: boolean;
  dead: boolean;
  /** 胜利达成后第一个 mouse 事件在 v.events 中的索引；null＝胜利后无事件 */
  tailStart: number | null;
  openedSafe: number;
  safeCount: number;
}

/** flop 语义重放（videowin.ts 1:1 移植），带索引跟踪：
 *  返回胜利是否达成与「胜局后第一个 mouse 事件」位置。
 *  坐标按 cellPixelSize 折算到 16px 口径（flop：t.x/squareSize*16）。 */
function replayToWin(v: ReturnType<typeof parseEvf>): ReplayResult {
  const rows = v.height, cols = v.width, N = rows * cols;
  // ⚠️ 用 v.board（'*'/邻雷数数字盘串，judgeVideoOutcome 同源）；
  //    v.grid 是雷区位图（非雷格全是 "0"），当盘串用会把 0 号泛洪全盘引爆
  const boardStr = v.board;
  const mines = new Uint8Array(N), nums = new Uint8Array(N);
  let safeCount = 0;
  for (let i = 0; i < N; i++) {
    const ch = boardStr[i];
    if (ch === "*") mines[i] = 1;
    else { nums[i] = ch.charCodeAt(0) - 48; safeCount++; }
  }
  const k = 16 / v.cellPixelSize;
  const evs = v.events;
  const opened = new Uint8Array(N), flagged = new Uint8Array(N), questioned = new Uint8Array(N);
  let dead = false, openedCount = 0, marks = v.useQuestion;
  let tailStart: number | null = null;

  const inside = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
  const flagsAround = (c: number, r: number) => {
    let n = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if (inside(c + dc, r + dr) && flagged[(r + dr) * cols + c + dc]) n++;
    return n;
  };
  const open = (c: number, r: number): boolean => {
    if (!inside(c, r)) return false;
    const i = r * cols + c;
    if (opened[i] || flagged[i]) return false;
    opened[i] = 1; openedCount++;
    if (mines[i]) { dead = true; return true; }
    if (nums[i] === 0) openAround(c, r);
    return true;
  };
  const openAround = (c: number, r: number): boolean => {
    if (!inside(c, r)) return false;
    const i = r * cols + c;
    if (!opened[i] || !(nums[i] === 0 || nums[i] === flagsAround(c, r))) return false;
    let any = false;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) any = open(c + dc, r + dr) || any;
    return any;
  };
  const toggleLabel = (c: number, r: number): boolean => {
    if (!inside(c, r)) return false;
    const i = r * cols + c;
    if (opened[i]) return false;
    if (marks && flagged[i]) { flagged[i] = 0; questioned[i] = 1; }
    else if (flagged[i]) { flagged[i] = 0; questioned[i] = 0; }
    else if (questioned[i]) { flagged[i] = 0; questioned[i] = 0; }
    else { flagged[i] = 1; questioned[i] = 0; }
    return true;
  };

  let lp = false, lv = false, rp = false, rv = false, sv = false;
  for (let idx = 0; idx < evs.length; idx++) {
    const e = evs[idx];
    if (!e.mouse) continue; // gameState/boardEvent/metric/pause 不影响盘面
    if (dead) break;
    if (openedCount === safeCount) { tailStart = idx; break; }
    const col = Math.floor((e.x! * k) / 16);
    const row = Math.floor((e.y! * k) / 16);
    switch (e.mouse) {
      case "lc": lp = lv = true; break;
      case "lr":
        if (rp || sv) openAround(col, row);
        else if (lv) open(col, row);
        lp = lv = rv = sv = false;
        break;
      case "rc":
        if (!lp) { if (toggleLabel(col, row)) rv = false; else rv = true; }
        rp = true;
        break;
      case "rr":
        if (lp) openAround(col, row);
        rp = lv = rv = sv = false;
        break;
      case "mc": break;
      case "mr": openAround(col, row); break;
      case "cc": break; // 双击按下：按下语义已由键态覆盖（flop readevf 消歧为 lc/rc）
      case "sc": lp = lv = sv = true; break;
      case "mt": marks = !marks; break;
    }
  }
  const win = !dead && openedCount === safeCount;
  return { win, dead, tailStart, openedSafe: openedCount, safeCount };
}

/** 从 parseEvf 结果提取 buildRankedEvf 输入（保留 winIdx 前的 mouse 事件） */
function toOnlineEvents(v: ReturnType<typeof parseEvf>, keepIdx: number) {
  const out: { mouse: number; sec: number; hun: number; ms: number; x: number; y: number }[] = [];
  let stray = 0; // 非 mouse 非 pause 事件（排名流不应有）
  for (let i = 0; i < keepIdx; i++) {
    const e = v.events[i];
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
  // 默认：全部本站排名 EVF（指纹说了算，不设时间窗）
  return prisma.videoInfo.findMany({
    where: { software: "Saolei.wang" },
    select: { id: true, filepath: true },
    orderBy: { id: "asc" },
  });
}

async function main() {
  const rows = await loadIds();
  console.log(`待处理 ${rows.length} 条${DRY ? "（dry-run）" : ""}${SCAN ? "（scan）" : ""}`);

  let affected = 0, fixed = 0, skipped = 0, failed = 0;
  const affectedIds: number[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    try {
      const oldPath = path.join(VIDEOS, row.filepath.replace(/^\//, ""));
      if (!existsSync(oldPath)) { console.log(`SKIP ${id}: 文件不存在 ${row.filepath}`); skipped++; continue; }
      const oldBuf = readFileSync(oldPath);
      const v = parseEvf(new Uint8Array(oldBuf));

      const r = replayToWin(v);
      if (!r.win) { skipped++; continue; } // 非胜局（loss/incomplete）无补洞段
      if (r.tailStart === null) { skipped++; continue; } // 胜局即流尾，干净
      const tail = v.events.length - r.tailStart;
      affected++;
      affectedIds.push(id);
      if (SCAN || DRY) {
        console.log(`AFFECT ${id}: tail=${tail} 胜利时刻=${v.events[r.tailStart - 1 >= 0 ? r.tailStart - 1 : 0]?.time?.toFixed(3)}s 文件=${row.filepath}`);
        if (SCAN) continue;
      }
      if (SCAN) continue;

      // —— 剥离 + 重编码（排名上传同管线，v4）——
      if (v.cellPixelSize !== 16) throw new Error(`cellPixelSize=${v.cellPixelSize} 非 16，人工核查`);
      const keepIdx = r.tailStart;
      const { out: kept, stray } = toOnlineEvents(v, keepIdx);
      if (stray > 0) throw new Error(`胜局前含 ${stray} 个非鼠标事件，人工核查`);
      const software = v.software;
      if (software !== RANKED_SOFTWARE && !software.startsWith(`${RANKED_SOFTWARE} `)) {
        throw new Error(`software=${software} 非本站排名局`);
      }
      // 早期排名局 software 无版本号后缀（"Saolei.wang"），重编码由 buildRankedEvf 补默认版本
      const clientVersion = software.startsWith(`${RANKED_SOFTWARE} `)
        ? software.slice(RANKED_SOFTWARE.length + 1) : undefined;
      // grid（"0"/"*" 串数组）→ 雷区 0/1 数组
      const board = new Uint8Array(v.width * v.height);
      const gridStr = v.grid.join("");
      for (let i = 0; i < board.length; i++) board[i] = gridStr[i] === "*" ? 1 : 0;
      const evf = buildRankedEvf({
        width: v.width, height: v.height, mines: v.mines, board,
        questionMarks: v.useQuestion, nf: v.nf, bbbv: v.bbbv,
        scoreCsec: Math.round(v.rtimeMs / 10), scoreMs: v.rtimeMs,
        events: kept, player: v.playerIdentifier,
        uniqueIdentifier: v.uniqueIdentifier, won: true, clientVersion,
        startedAtMs: v.startTime != null ? v.startTime / 1000 : undefined,
        endedAtMs: v.endTime != null ? v.endTime / 1000 : undefined,
      });
      const newBuf = Buffer.from(evf);
      // 产物自校验：重放仍 win 且无尾巴
      const nv = parseEvf(new Uint8Array(newBuf));
      const nr = replayToWin(nv);
      if (!nr.win || nr.tailStart !== null || nv.events.filter((e) => e.mouse).length !== kept.length) {
        throw new Error(`产物自校验失败 win=${nr.win} tail=${nr.tailStart}`);
      }

      const video = await prisma.video.findUnique({ where: { id: row.id }, select: { createTime: true } });
      if (!video) throw new Error("video 行缺失");
      const t = new Date(Number(video.createTime) * 1000);
      const dir = `/${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
      const hash = createHash("md5").update(newBuf).digest("hex");
      const newFilepath = `${dir}/${hash}.evf`;
      const newDiskPath = path.join(VIDEOS, newFilepath.replace(/^\//, ""));
      console.log(`FIX ${id}: ${row.filepath} -> ${newFilepath} (${oldBuf.length}B -> ${newBuf.length}B, tail=${tail})`);
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
