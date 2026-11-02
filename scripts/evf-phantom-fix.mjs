// 存量 EVF 幻影右键修复（2026-11-02，353011 案）
// 根因：canonicalizeOnlineEvents 把「挂 rv 的 rc + chord 折叠」留下尾随 rr，
//       回放/统计状态机给该 rr 补记 Right++ + wastedRight++（原始流中 rv 已被中间 lr 清掉、计 0）。
// 修复：字节级手术——仅删除幻影对的 8 字节事件记录（rc+rr），其余字节原样保留；
//       尾部事件被删导致事件流末端毫秒变化时同步改写头部 rtime u24(12-14)；
//       evf_sig 重签（HMAC(AUTH_SECRET 派生键)）。
// 用法: node /tmp/evf-phantom-fix.mjs <list.tsv> <videoRoot> [--apply] [--sql=<out.sql>]
//   list.tsv 每行: id<TAB>filepath<TAB>evf_sig(可空)   —— SELECT v.id, i.filepath, IFNULL(i.evf_sig,'') ...
//   缺省 dry-run（只打印）；--apply 才写文件并产出 SQL
// 只处理 v0.3 本站格式（版本字节=3）；其他版本跳过并报告。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const [listFile, videoRoot] = process.argv.slice(2, 4);
const apply = process.argv.includes("--apply");
const sqlArg = process.argv.find((a) => a.startsWith("--sql="));
if (!listFile || !videoRoot) {
  console.error("用法: node evf-phantom-fix.mjs <list.tsv> <videoRoot> [--apply] [--sql=out.sql]");
  process.exit(1);
}

// AUTH_SECRET：生产 /home/deploy/saolei.wang/.env（同 /tmp/evf-rewrite.mjs 先例）；本地测试无此文件也可跑 dry-run
let secret = "";
try {
  for (const line of readFileSync("/home/deploy/saolei.wang/.env", "utf8").split("\n")) {
    const m = /^AUTH_SECRET=(.+)\s*$/.exec(line);
    if (m) secret = m[1].replace(/^["']|["']$/g, "");
  }
} catch {}
const sigOf = (buf) => {
  if (!secret) throw new Error("AUTH_SECRET 未找到（/home/deploy/saolei.wang/.env）");
  return createHmac("sha256", createHmac("sha256", secret).update("evf-sig-v1").digest()).update(buf).digest("hex");
};

const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];

// ---- v0.3 布局：定长头 15B + 8 个 \0 结尾串 + 雷区位图 + 8B/事件 + 结束符 + 32B 校验和段 ----
function parseSiteEvf(buf) {
  if (buf[0] !== 3) return null; // 只处理本站 v0.3
  const height = buf[3], width = buf[4];
  let p = 15;
  for (let i = 0; i < 8; i++) { while (p < buf.length && buf[p] !== 0) p++; p++; }
  const bmpAt = p;
  const bmpLen = Math.ceil((width * height) / 8);
  p += bmpLen;
  const events = []; // {recAt, code, ms, x, y}
  while (p + 8 <= buf.length) {
    const code = buf[p];
    if (code === 0) { p++; break; }
    events.push({ recAt: p, code, ms: u24(buf, p + 1), x: u16(buf, p + 4), y: u16(buf, p + 6) });
    p += 8;
  }
  const tailAt = p; // 结束符之后（含 32B 校验和段）原样保留
  return { width, height, summary: buf[1], bmp: buf.subarray(bmpAt, bmpAt + bmpLen), events, tailAt };
}

// ---- flop 状态机（replay-core 同语义，EVF 鼠标码）+ 幻影对检测 ----
// EVF 码：1 mv / 2 lc / 3 lr / 4 rc / 5 rr / 6 mc / 7 mr / 9 cc(=sc)
function detectPhantoms(parsed) {
  const { width: W, height: H, bmp, events } = parsed;
  const N = W * H;
  const mines = new Uint8Array(N);
  for (let i = 0; i < N; i++) mines[i] = (bmp[i >> 3] >> (7 - (i & 7))) & 1;
  const nums = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    if (mines[i]) { nums[i] = -1; continue; }
    let c = 0; const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && mines[ny * W + nx]) c++;
    }
    nums[i] = c;
  }
  const state = new Uint8Array(N), flagged = new Uint8Array(N), questioned = new Uint8Array(N);
  let openedSafe = 0, dead = false;
  const safeTotal = N - mines.reduce((a, b) => a + b, 0);
  const flagsAround = (i) => {
    let f = 0; const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && flagged[ny * W + nx]) f++;
    }
    return f;
  };
  const openAroundIdx = (i) => {
    if (i < 0 || i >= N || state[i] !== 1) return false;
    if (!(nums[i] === 0 || nums[i] === flagsAround(i))) return false;
    let any = false; const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const j = ny * W + nx;
      if (state[j] !== 0 || flagged[j]) continue;
      state[j] = 1;
      if (mines[j]) { dead = true; return true; }
      openedSafe++;
      if (nums[j] === 0) any = openAroundIdx(j) || any; else any = true;
    }
    return any;
  };
  const openCell = (i) => {
    if (i < 0 || i >= N || state[i] !== 0 || flagged[i]) return false;
    state[i] = 1;
    if (mines[i]) { dead = true; return true; }
    openedSafe++;
    if (nums[i] === 0) openAroundIdx(i);
    return true;
  };
  const toggleLabel = (i, marks) => {
    if (i < 0 || i >= N || state[i] === 1) return false;
    if (marks && flagged[i]) { flagged[i] = 0; questioned[i] = 1; }
    else if (flagged[i]) { flagged[i] = 0; questioned[i] = 0; }
    else if (questioned[i]) { flagged[i] = 0; questioned[i] = 0; }
    else { flagged[i] = 1; questioned[i] = 0; }
    return true;
  };

  let lp = false, lv = false, rp = false, rv = false, sv = false, marks = false;
  let over = false;
  let hungIdx = -1;      // 挂 rv 的 rc 事件下标
  let phantom = false;   // 挂起期间见过 mr（chord 折叠）
  const drop = new Set();
  const cellOf = (e) => {
    const cx = (e.x / 16) | 0, cy = (e.y / 16) | 0;
    return cx >= 0 && cx < W && cy >= 0 && cy < H ? cy * W + cx : -1;
  };
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (over) break;
    const i = cellOf(e);
    switch (e.code) {
      case 2: lp = lv = true; break; // lc
      case 3: // lr
        if (rp || sv) { openAroundIdx(i); }
        else if (lv) { openCell(i); }
        lp = lv = rv = sv = false; // flop 语义：rv 被 lr 清掉 → 挂起解除，幻影不成立
        hungIdx = -1;
        break;
      case 4: // rc
        if (!lp) {
          if (toggleLabel(i, marks)) { rv = false; }
          else { rv = true; hungIdx = k; }
        }
        rp = true;
        break;
      case 5: // rr
        if (lp) { openAroundIdx(i); }
        else if (rv) {
          if (phantom && hungIdx >= 0) {
            drop.add(hungIdx); drop.add(k); // 幻影对：rc 与其闭合 rr 一并删除
          }
        }
        rp = lv = rv = sv = false;
        hungIdx = -1; phantom = false;
        break;
      case 7: // mr（本站流中＝chord 折叠产物）
        openAroundIdx(i);
        if (rv && hungIdx >= 0) phantom = true;
        break;
      case 9: lp = lv = sv = true; break; // cc＝sc
      case 1: case 6: case 8: case 10: case 11: case 12: break; // mv/mc/pf/l/r/m 不影响状态
      default: break;
    }
    if (openedSafe >= safeTotal || dead) over = true;
  }
  return drop;
}

// ---- 单文件处理 ----
const rows = readFileSync(listFile, "utf8").trim().split("\n").map((l) => l.split("\t"));
const sqlLines = [];
let scanned = 0, skippedVer = 0, changed = 0, totalPairs = 0, tailChanged = 0;
const metricsIds = [];
const tailList = [];

for (const [idS, fp, sig] of rows) {
  if (!idS || !fp) continue;
  const id = idS.trim();
  const path = videoRoot.replace(/\/$/, "") + fp;
  let buf;
  try { buf = readFileSync(path); } catch { console.log(`${id} SKIP 读文件失败 ${fp}`); continue; }
  scanned++;
  const parsed = parseSiteEvf(buf);
  if (!parsed) { skippedVer++; console.log(`${id} SKIP 非本站 v0.3（版本字节=${buf[0]}）`); continue; }
  const drop = detectPhantomSafe(parsed, id);
  if (drop.size === 0) continue;
  const pairs = drop.size / 2;
  totalPairs += pairs;
  changed++;
  metricsIds.push(id);
  // 字节手术：按 recAt 降序删除记录
  const recs = [...drop].map((k) => parsed.events[k].recAt).sort((a, b) => b - a);
  let out = Buffer.from(buf);
  for (const at of recs) out = Buffer.concat([out.subarray(0, at), out.subarray(at + 8)]);
  // 尾部毫秒核对：删除的是末尾事件则头部 rtime 同步收缩
  const oldTail = lastEventMs(buf);
  const newTail = lastEventMs(out);
  if (newTail !== oldTail) {
    tailChanged++;
    tailList.push(`${id}\t${newTail}`);
    out[12] = (newTail >> 16) & 0xff; out[13] = (newTail >> 8) & 0xff; out[14] = newTail & 0xff;
  }
  console.log(`${id} ${fp} 幻影对=${pairs} 事件 ${parsed.events.length} -> ${parsed.events.length - drop.size}${newTail !== oldTail ? " ⚠️尾部毫秒变化 " + oldTail + "->" + newTail : ""}`);
  if (apply) {
    const newSig = sig ? sigOf(out) : null; // 先算签名（本地无 AUTH_SECRET 时不在写文件后炸）
    mkdirSync("/tmp/evf-phantom-backup", { recursive: true });
    copyFileSync(path, `/tmp/evf-phantom-backup/${id}.evf`);
    writeFileSync(path, out);
    if (newSig) sqlLines.push(`UPDATE video_info SET evf_sig='${newSig}' WHERE id=${id};`);
  }
}

function lastEventMs(b) {
  const parsed = parseSiteEvf(b);
  return parsed && parsed.events.length ? parsed.events[parsed.events.length - 1].ms : 0;
}
function detectPhantomSafe(parsed, id) {
  try { return detectPhantoms(parsed); } catch (err) { console.log(`${id} SKIP 检测异常 ${err.message}`); return new Set(); }
}

console.log(`\n== 扫描 ${scanned} 个 evf（跳过非 v0.3 ${skippedVer}）| 含幻影 ${changed} 个 | 共 ${totalPairs} 对 | 尾毫秒变化 ${tailChanged} ==`);
if (apply) {
  if (sqlArg && sqlLines.length) { writeFileSync(sqlArg, sqlLines.join("\n") + "\n"); console.log(`SQL 已产出: ${sqlArg}（${sqlLines.length} 行）`); }
  if (metricsIds.length) { writeFileSync("/tmp/evf-phantom-ids.txt", metricsIds.join("\n") + "\n"); console.log("ids 清单: /tmp/evf-phantom-ids.txt（供 video-metrics --ids-file）"); }
  if (tailList.length) { writeFileSync("/tmp/evf-phantom-tail.tsv", tailList.join("\n") + "\n"); console.log("尾毫秒变化清单: /tmp/evf-phantom-tail.tsv（供 recalc-ranked-rtime --list）"); }
  console.log("备份目录: /tmp/evf-phantom-backup/");
}
