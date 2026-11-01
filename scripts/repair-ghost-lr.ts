// 存量修复（2026-11-01 352535 案）：5673ca5（14:41）部署后上传的排名录像被
// canonicalize 案 B「孤立 lr 一律合成 lc+lr」注入幽灵左键对（chord 尾随无效开格）。
// 本脚本用权威快照（7 天保留）+ 盘面感知 canonicalize（真开格才合成）重新导出 evf，
// 改名换 hash、evf_sig 重签、删旧文件；metrics 由 video-metrics --ids-file 定点重算。
//
// 用法（生产机 /home/deploy/saolei.wang，需先载入 .env 的 AUTH_SECRET/DATABASE_URL）：
//   set -a && source .env && set +a
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/repair-ghost-lr.ts \
//     --ids-file=/tmp/ghost-ids.txt [--dry] [--limit=N]
//
// 幂等：新旧字节一致即跳过；DB 更新失败不删旧文件。
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { prisma } from "../src/lib/db";
import { canonicalizeOnlineEvents, repairWinningEvents } from "../src/lib/avfwrite";
import { buildRankedEvf, RANKED_SOFTWARE } from "../src/lib/evfwrite";
import { evfSignature } from "../src/core/src/lib/evf-sign";
import { authorityBaseFor, authorityAuthHeaders } from "../src/core/src/lib/authority-endpoint";

const arg = (name: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const DRY = process.argv.includes("--dry");
const REPO = process.cwd();
const VIDEOS = path.join(REPO, "videos");
const STORE = "/home/deploy/.saolei-authority-store";

/** 快照加载：北京本部磁盘直读；区域节点（cd/hz/gz）走 /snapshot HTTP 回退 */
async function loadSnapshot(gameId: string, uid: number) {
  const local = path.join(STORE, `${gameId}.json`);
  if (existsSync(local)) return JSON.parse(readFileSync(local, "utf8")).exported;
  const base = authorityBaseFor(gameId);
  if (!base) throw new Error(`快照缺失且 region 未配置 URL: ${gameId}`);
  const res = await fetch(`${base}/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authorityAuthHeaders(gameId) },
    body: JSON.stringify({ gameId, uid }),
  });
  if (!res.ok) throw new Error(`快照缺失 ${gameId}（${base} -> ${res.status}）`);
  return await res.json();
}

/** 解析 EVF v0.3 头部：15B 定长 + 8 个 cstr（software/player/race/uid/start/end/country/uuid） */
function parseEvfHeader(buf: Buffer) {
  if (buf[0] !== 3) throw new Error("非 EVF v0.3");
  let pos = 15;
  const strs: string[] = [];
  for (let k = 0; k < 8; k++) {
    let end = pos;
    while (end < buf.length && buf[end] !== 0) end++;
    strs.push(buf.slice(pos, end).toString("utf8"));
    pos = end + 1;
  }
  const [software, player, , gameId] = strs;
  const clientVersion = software.startsWith(`${RANKED_SOFTWARE} `)
    ? software.slice(RANKED_SOFTWARE.length + 1)
    : undefined;
  if (!gameId) throw new Error("头部无 uniqueIdentifier(gameId)");
  return { player, gameId, clientVersion };
}

async function main() {
  const idsFile = arg("ids-file");
  const idsArg = arg("ids");
  const limit = Number(arg("limit") ?? 0);
  const ids = (idsFile ? readFileSync(idsFile, "utf8") : (idsArg ?? ""))
    .split(/\s+/).map((s) => s.trim()).filter(Boolean).map(Number);
  if (!ids.length) throw new Error("无 id：--ids-file 或 --ids 必填");
  const todo = limit > 0 ? ids.slice(0, limit) : ids;
  console.log(`待处理 ${todo.length} / 共 ${ids.length} 条${DRY ? "（dry-run）" : ""}`);

  let rebuilt = 0, skippedSame = 0, missing = 0, failed = 0;
  for (const id of todo) {
    try {
      const info = await prisma.videoInfo.findUnique({
        where: { id: BigInt(id) },
        select: { filepath: true, evfSig: true, software: true },
      });
      const video = await prisma.video.findUnique({
        where: { id: BigInt(id) },
        select: { createTime: true, user: true },
      });
      if (!info?.filepath || !video) { console.log(`SKIP ${id}: 库内无行`); missing++; continue; }

      const oldPath = path.join(VIDEOS, info.filepath.replace(/^\//, ""));
      if (!existsSync(oldPath)) { console.log(`SKIP ${id}: 旧文件不存在 ${info.filepath}`); missing++; continue; }
      const oldBuf = readFileSync(oldPath);
      const { player, gameId, clientVersion } = parseEvfHeader(oldBuf);

      const ex = await loadSnapshot(gameId, Number(video.user));
      if (!ex) { console.log(`SKIP ${id}: 快照缺失 ${gameId}`); missing++; continue; }

      /* 与排名上传路由同管线：canonicalize（盘面感知）→ repair → buildRankedEvf */
      const canon = canonicalizeOnlineEvents(ex.events, {
        width: ex.width, height: ex.height, board: ex.board, questionMarks: ex.questionMarks,
      });
      const exportEvents = repairWinningEvents(
        ex.width, ex.height, ex.board, ex.questionMarks, canon, ex.scoreMs,
      );
      const evf = buildRankedEvf({
        width: ex.width, height: ex.height, mines: ex.mines, board: ex.board,
        questionMarks: ex.questionMarks, nf: ex.nf, bbbv: ex.bbbv,
        scoreCsec: ex.scoreCsec, scoreMs: ex.scoreMs, events: exportEvents,
        player, uniqueIdentifier: gameId, won: ex.won, clientVersion,
      });
      const newBuf = Buffer.from(evf);
      if (newBuf.equals(oldBuf)) { skippedSame++; continue; }

      const t = new Date(Number(video.createTime) * 1000); // video.create_time = Unix 秒
      const dir = `/${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
      const hash = createHash("md5").update(newBuf).digest("hex");
      const newFilepath = `${dir}/${hash}.evf`;
      const newDiskPath = path.join(VIDEOS, newFilepath.replace(/^\//, ""));
      const removed = oldBuf.length - newBuf.length;
      if (DRY) {
        console.log(`DRY ${id}: ${info.filepath} -> ${newFilepath} (${oldBuf.length}B -> ${newBuf.length}B, -${removed}B)`);
        continue;
      }
      mkdirSync(path.dirname(newDiskPath), { recursive: true });
      writeFileSync(newDiskPath, newBuf);
      await prisma.videoInfo.update({
        where: { id: BigInt(id) },
        data: { filepath: newFilepath, evfSig: evfSignature(new Uint8Array(newBuf)) },
      });
      if (newDiskPath !== oldPath) unlinkSync(oldPath);
      rebuilt++;
      console.log(`OK ${id}: ${info.filepath} -> ${newFilepath} (-${removed}B)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`完成：重导 ${rebuilt}，跳过(一致) ${skippedSame}，缺料 ${missing}，失败 ${failed}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
