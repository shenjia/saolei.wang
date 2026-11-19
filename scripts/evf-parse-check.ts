// evf 解析器验证：node_modules/.bin/jiti scripts/evf-parse-check.ts <file.evf>
// 对照 ms-toollib 口径核验：解析到文件尾、雷数自洽、事件统计、时间与文件名一致
import { readFileSync } from "node:fs";
import { parseEvf } from "../src/lib/evf";

const file = process.argv[2];
if (!file) {
  console.error("用法: node --experimental-strip-types scripts/evf-parse-check.ts <file.evf>");
  process.exit(1);
}

const buf = readFileSync(file);
const v = parseEvf(new Uint8Array(buf));

console.log("== 头部 ==");
console.log(`version: 0.${v.version}`);
console.log(`software: ${v.software}${v.translated ? ` (转码自 ${v.translateSoftware || "未知"}, 原编码 ${v.originalEncoding || "未知"})` : ""}`);
console.log(`completed=${v.isCompleted} official=${v.isOfficial} fair=${v.isFair} nf=${v.nf}`);
console.log(`禁问号=${v.useQuestion} 禁越界=${v.useCursorPosLim} 自动重开=${v.useAutoRestart}`);
console.log(`盘面: ${v.height}行 x ${v.width}列, ${v.mines}雷, level=${v.level}, cell=${v.cellPixelSize}px`);
console.log(`mode=${v.mode} (${v.modeName}), 3BV=${v.bbbv}, rtime=${v.rtimeMs}ms (${(v.rtimeMs / 1000).toFixed(3)}s)`);
console.log(`country: ${v.country}`);
if (v.startTime !== null && v.endTime !== null) {
  console.log(`开始: ${new Date(v.startTime / 1000).toISOString()}`);
  console.log(`结束: ${new Date(v.endTime / 1000).toISOString()}`);
}
console.log(`玩家: ${v.playerIdentifier} | 赛事: ${v.raceIdentifier || "-"} | 唯一标识: ${v.uniqueIdentifier || "-"}`);
console.log(`设备UUID: ${v.deviceUuid}`);
console.log(`校验和: ${v.checksum}`);

// 自洽性核验
const mineCount = (v.board.match(/\*/g) ?? []).length;
const stat: Record<string, number> = {};
for (const e of v.events) {
  const k = e.mouse ?? e.gameState ?? e.boardEvent?.type ?? e.metric?.kind ?? (e.pause !== undefined ? "pause" : "?");
  stat[k] = (stat[k] ?? 0) + 1;
}
const last = v.events[v.events.length - 1]!.time;
console.log("\n== 自洽性 ==");
console.log(`雷区位图雷数 = ${mineCount}（应为 ${v.mines}）: ${mineCount === v.mines ? "OK" : "FAIL"}`);
console.log(`事件总数: ${v.events.length}`);
console.log(`事件分类:`, stat);
console.log(`最后事件时间 = ${(last * 1000).toFixed(0)}ms ≥ rtime ${v.rtimeMs}ms: ${last * 1000 >= v.rtimeMs ? "OK" : "FAIL"}`);
const bbbvS = (v.bbbv / (v.rtimeMs / 1000)).toFixed(3);
console.log(`3BV/s = ${bbbvS}`);

console.log("\n== 棋盘前 4 行 ==");
for (let i = 0; i < 4; i++) {
  console.log(v.board.slice(i * v.width, (i + 1) * v.width));
}

console.log("\n== 前 10 个非 mv 事件 ==");
for (const e of v.events.filter((e) => e.mouse !== "mv").slice(0, 10)) {
  console.log(
    `${e.time.toFixed(3)}s`,
    e.mouse ?? e.gameState ?? JSON.stringify(e.boardEvent ?? e.metric ?? e.pause),
    e.x !== undefined ? `(${e.x},${e.y})` : "",
  );
}
