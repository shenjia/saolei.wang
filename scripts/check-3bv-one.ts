// 扫描全库：video_info.board_3bv vs AVF 文件头自报 3BV 不一致的录像
// 分批：按 id 区间拉 video_info（board_3bv + filepath + board 雷位串），对本地 videos/ 文件解析
import { readFileSync, existsSync } from "fs";
import { avfToRawvf } from "../src/lib/avf";
import { mvfToRawvfBest } from "../src/lib/mvf-best";
import { execSync } from "child_process";

// ---- 3BV 计算（标准口径：空区 4 连通 + 边界数字 + 独立数字格）----
function calc3bvFromBoard(boardLines: string[], conn: 4 | 8): { bv: number; regions: number; singles: number } | null {
  const H = boardLines.length;
  const W = boardLines[0]?.length ?? 0;
  if (!W || boardLines.some((r) => r.length !== W)) return null;
  const isMine = (x: number, y: number) => boardLines[y][x] === "*";
  const num = (x: number, y: number) => {
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && isMine(nx, ny)) c++;
    }
    return c;
  };
  const dirs = conn === 4 ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const region = new Int32Array(W * H).fill(-1);
  let regions = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (isMine(x, y) || num(x, y) !== 0 || region[i] !== -1) continue;
    const stack = [[x, y]];
    region[i] = regions;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const a = ny * W + nx;
        if (isMine(nx, ny) || region[a] === regions) continue;
        region[a] = regions;
        if (num(nx, ny) === 0) stack.push([nx, ny]);
      }
    }
    regions++;
  }
  let singles = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!isMine(x, y) && region[y * W + x] < 0) singles++;
  }
  return { bv: regions + singles, regions, singles };
}

// ---- 主流程 ----
const MODE = process.argv[2] ?? "count"; // count | list | sample
const LIMIT = process.argv[3] ? parseInt(process.argv[3], 10) : 100; // list 模式显示条数

// 分批拉全库（约 30 万行，避免一次性载入内存爆掉）
const BATCH = 5000;
let lastId = 0;
let total = 0, checked = 0, fileMissing = 0, parseFail = 0;
const mismatches: { id: number; db: number; header: number; calc4: number | null; calc8: number; filepath: string; level: string; software: string }[] = [];
const headerMiss: { id: number; db: number; filepath: string }[] = []; // mvf 无 3BV 头等

const t0 = Date.now();
for (;;) {
  const rows = execSync(
    `mysql -uroot saolei -N -e "SELECT vi.id, vi.board_3bv, vi.filepath, vi.board, v.level, vi.software FROM video_info vi JOIN video v ON v.id=vi.id WHERE vi.id > ${lastId} ORDER BY vi.id LIMIT ${BATCH};"`,
    { maxBuffer: 64 * 1024 * 1024 }
  ).toString();
  if (!rows.trim()) break;
  for (const line of rows.split("\n")) {
    if (!line.trim()) continue;
    const [idS, db3bvS, filepath, board, level, software] = line.split("\t");
    const id = parseInt(idS, 10);
    const db3bv = parseInt(db3bvS, 10);
    lastId = id;
    total++;
    // 文件存在性
    const fp = "videos" + filepath;
    if (!existsSync(fp)) { fileMissing++; continue; }
    let lines: string[] | null = null;
    let ext = filepath.toLowerCase().endsWith(".avf") ? "avf" : filepath.toLowerCase().endsWith(".mvf") ? "mvf" : null;
    if (!ext) continue;
    try {
      const buf = readFileSync(fp);
      lines = ext === "avf" ? avfToRawvf(buf) : (mvfToRawvfBest(buf)?.lines ?? null);
    } catch { parseFail++; continue; }
    if (!lines) { parseFail++; continue; }
    checked++;
    // 文件头 3BV
    const bvLine = lines.find((l) => l.startsWith("3BV:"));
    const header = bvLine ? parseInt(bvLine.slice(5).trim(), 10) : null;
    // 文件盘复算（4连 + 8连）
    const boardLines = lines.slice(lines.indexOf("Board:") + 1, lines.indexOf("Events:"));
    const c4 = calc3bvFromBoard(boardLines, 4);
    const c8 = calc3bvFromBoard(boardLines, 8);
    if (header !== null && header !== db3bv) {
      mismatches.push({ id, db: db3bv, header: header, calc4: c4?.bv ?? null, calc8: c8?.bv ?? -1, filepath, level, software });
    }
  }
  if (total % 50000 < BATCH) console.error(`... ${total} rows, ${checked} checked, ${mismatches.length} mismatch (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  if (rows.split("\n").filter(Boolean).length < BATCH) break;
}

console.error(`\n=== 完成：总 ${total}，本地有文件 ${checked}，文件缺失 ${fileMissing}，解析失败 ${parseFail} ===`);
console.error(`=== 库值 vs 文件头不一致：${mismatches.length} 条 ===`);
// 按「文件头 == 8连复算」且「库值 == 4连复算」分类
let both = 0, dbIs4 = 0, other = 0;
for (const m of mismatches) {
  if (m.header === m.calc8 && m.db === m.calc4) both++;
  else if (m.db === m.calc4) dbIs4++;
  else other++;
}
console.error(`其中：文件头=8连复算 且 库值=4连复算: ${both}；仅库值=4连: ${dbIs4}；其他: ${other}`);
if (MODE === "list") {
  console.log("id\tdb\theader\tcalc4\tcalc8\tlevel\tsoftware\tfilepath");
  for (const m of mismatches.slice(0, LIMIT)) {
    console.log(`${m.id}\t${m.db}\t${m.header}\t${m.calc4}\t${m.calc8}\t${m.level}\t${m.software}\t${m.filepath}`);
  }
  console.log(`(共 ${mismatches.length} 条，显示前 ${Math.min(LIMIT, mismatches.length)})`);
} else if (MODE === "sample") {
  console.log(JSON.stringify(mismatches.slice(0, LIMIT), null, 1));
}
