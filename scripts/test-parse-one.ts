// 单文件试点：验证解析字段与 DB video_info 对齐
import { readFileSync } from "fs";
import { avfToRawvf } from "../src/lib/avf";
import { mvfToRawvf } from "../src/lib/mvf";
import { formatRawvf } from "../src/lib/rawvf";

const fp = process.argv[2]!;
const buf = readFileSync(fp);
const ext = fp.slice(fp.lastIndexOf(".") + 1).toLowerCase();
const lines = ext === "avf" ? avfToRawvf(buf) : mvfToRawvf(buf);
if (!lines) { console.error("PARSE FAIL"); process.exit(1); }
const p = formatRawvf(lines);
console.log(JSON.stringify({
  player: p.player, level: p.level, bbbv: p.bbbv, timeMs: p.timeMs,
  program: p.program, version: p.version, noflag: p.noflag,
}, null, 2));
