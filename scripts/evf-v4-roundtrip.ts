// EVF v4 生成器往返验证：node --experimental-strip-types scripts/evf-v4-roundtrip.ts
// buildRankedEvf(v4) → parseEvf → evfToRawvf 全链路自洽：头部字段、增量时间戳
// （含 >255ms 停顿桥接、>65535ms 多段停顿）、增量坐标（含负值包装域）、
// 哨兵化、单调钳制、起止时间戳推算链、summary 位语义。
import { buildRankedEvf } from "../src/lib/evfwrite";
import { parseEvf, evfToRawvf } from "../src/lib/evf";
import type { OnlineEvent } from "../src/lib/avfwrite";

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/* 8x8 10 雷示例盘（前 10 格埋雷） */
function board8x8(): Uint8Array {
  const b = new Uint8Array(64);
  for (let i = 0; i < 10; i++) b[i] = 1;
  return b;
}
const ev = (mouse: number, x: number, y: number, ms: number): OnlineEvent => ({
  mouse, x, y, sec: Math.floor(ms / 1000), hun: Math.floor(ms / 10) % 100, ms,
});

console.log("== 用例 1：标准胜局（含 mv/点击、小间隔） ==");
{
  const events: OnlineEvent[] = [
    ev(1, 64, 64, 0),    // mv
    ev(3, 64, 64, 120),  // lc
    ev(5, 64, 64, 180),  // lr
    ev(1, 80, 96, 260),  // mv
    ev(9, 80, 96, 400),  // rc
    ev(17, 80, 96, 470), // rr
    ev(11, 96, 64, 600), // cc（双击按下）
    ev(65, 96, 64, 700), // mr
  ];
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: true, nf: false, bbbv: 24,
    scoreCsec: 654, scoreMs: 6540, events,
    won: true, player: "#42 测试", uniqueIdentifier: "game-1",
    clientVersion: "0.5", startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_006_540,
  });
  check("首字节版本 = 4", bytes[0] === 4);
  const v = parseEvf(bytes);
  check("version=4", v.version === 4);
  check("completed/official/fair 均 1", v.isCompleted && v.isOfficial && v.isFair);
  check("nf=0", v.nf === false);
  check("非转码", v.translated === false);
  check("问号位=1", v.useQuestion === true);
  check("盘面 8x8x10 cell16", v.height === 8 && v.width === 8 && v.mines === 10 && v.cellPixelSize === 16);
  check("mode=0 standard", v.mode === 0 && v.modeName === "standard");
  check("3BV=24", v.bbbv === 24);
  check("rtime=6540", v.rtimeMs === 6540);
  check("country=XX", v.country === "XX");
  check("起始时间戳", v.startTime === 1_700_000_000_000_000, String(v.startTime));
  check("结束时间戳", v.endTime === 1_700_000_006_540_000, String(v.endTime));
  check("software", v.software === "Saolei.wang 0.5");
  check("player", v.playerIdentifier === "#42 测试");
  check("unique", v.uniqueIdentifier === "game-1");
  check("uuid 空", v.deviceUuid === "");
  check("雷区逐格还原", v.grid.every((row, i) => row.split("").every((c, j) => (c === "*") === (i * 8 + j < 10))));
  const decoded = v.events.filter(e => e.mouse);
  check("事件数 8", decoded.length === 8, String(decoded.length));
  const want: [string, number, number, number][] = [
    ["mv", 64, 64, 0], ["lc", 64, 64, 120], ["lr", 64, 64, 180], ["mv", 80, 96, 260],
    ["rc", 80, 96, 400], ["rr", 80, 96, 470], ["cc", 96, 64, 600], ["mr", 96, 64, 700],
  ];
  decoded.forEach((e, i) => {
    const [m, x, y, ms] = want[i];
    check(`事件${i} ${m} @${ms}ms (${x},${y})`,
      e.mouse === m && e.time * 1000 === ms && e.x === x && e.y === y,
      `${e.mouse} ${e.time * 1000} (${e.x},${e.y})`);
  });
  const raw = evfToRawvf(bytes);
  check("evfToRawvf Program", raw.some(l => l === "Program: Saolei.wang"));
  check("evfToRawvf Version", raw.some(l => l === "Version: 0.5"));
  check("evfToRawvf Time", raw.some(l => l === "Time: 6.540"));
}

console.log("== 用例 2：长间隔停顿桥接（>255ms 单段 / >65535ms 多段 / 首事件重锚） ==");
{
  const events: OnlineEvent[] = [
    ev(3, 16, 16, 400),   // 首事件 400ms > 255 → 时间轴整体重锚到 0
    ev(5, 16, 16, 450),
    ev(3, 32, 32, 1000),  // 间隔 550ms：单段停顿
    ev(5, 32, 32, 1050),
    ev(3, 48, 48, 80000), // 间隔 78950ms：多段停顿
    ev(5, 48, 48, 80050),
  ];
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: true, bbbv: 24,
    scoreCsec: 8005, scoreMs: 80050, events, won: true,
  });
  const v = parseEvf(bytes);
  const decoded = v.events.filter(e => e.mouse);
  const times = decoded.map(e => e.time * 1000);
  check("时间戳精确还原（重锚 + 停顿累计）",
    times.join(",") === "0,50,600,650,79600,79650", times.join(","));
  const pauses = v.events.filter(e => e.pause);
  check("存在停顿事件", pauses.length >= 3, String(pauses.length));
  check("rtime 头部不受重锚影响", v.rtimeMs === 80050);
  // 流首类型守卫：首个事件是 lr（丢按下上报的极端情况）→ 前置同坐标 mv
  const guardBytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24,
    scoreCsec: 5, scoreMs: 50,
    events: [ev(5, 32, 32, 0), ev(3, 32, 32, 20), ev(5, 32, 32, 50)],
    won: true,
  });
  const guardV = parseEvf(guardBytes);
  const d2 = guardV.events.filter(e => e.mouse);
  check("流首守卫前置 mv", d2.length === 4 && d2[0].mouse === "mv" && d2[0].x === 32 && d2[0].y === 32,
    d2.map(e => e.mouse).join(","));
  check("守卫后时间轴不变", d2.map(e => e.time * 1000).join(",") === "0,0,20,50",
    d2.map(e => e.time * 1000).join(","));
  // 起止时间戳推算：只传 endedAtMs → start = end - rtime
  const endMs = 1_700_000_100_000;
  const bytes2 = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24, scoreCsec: 1, events: [],
    won: true, endedAtMs: endMs,
  });
  const v2 = parseEvf(bytes2);
  check("start=end-rtime 推算", v2.startTime === (endMs - 10) * 1000, String(v2.startTime));
  check("end 原值", v2.endTime === endMs * 1000);
  // AVF 时间戳串兜底
  const bytes3 = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24, scoreCsec: 100, events: [],
    won: true, timestamp: "5.11.2026.04:14:03:0123",
  });
  const v3 = parseEvf(bytes3);
  const wantEnd = new Date(2026, 10, 5, 4, 14, 3, 123).getTime();
  check("AVF 串解析 end", v3.endTime === wantEnd * 1000, String(v3.endTime));
  check("AVF 串解析 start", v3.startTime === (wantEnd - 1000) * 1000, String(v3.startTime));
  // 全缺＝0
  const bytes4 = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24, scoreCsec: 1, events: [], won: true,
  });
  const v4 = parseEvf(bytes4);
  check("全缺时间戳=0", v4.startTime === 0 && v4.endTime === 0);
}

console.log("== 用例 3：败局凭据语义 + 哨兵化 + 负坐标包装域 ==");
{
  const events: OnlineEvent[] = [
    ev(1, 64, 64, 0),
    ev(3, 200, 200, 100), // 盘外点击（8x8=128px 边界外）→ 哨兵 (128,128)
    ev(5, 128, 128, 200),
    ev(1, -6, -6, 300),   // 负坐标 mv（包装域 65530）→ v0.3 同为 u16 包装
  ];
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24,
    scoreCsec: 30, events, won: false,
  });
  const v = parseEvf(bytes);
  check("败局 completed=0", v.isCompleted === false);
  check("败局 official=0", v.isOfficial === false);
  check("败局 fair=0", v.isFair === false);
  check("nf 位不受胜负影响（nf=false→0）", v.nf === false);
  const decoded = v.events.filter(e => e.mouse);
  check("盘外点击哨兵化", decoded[1].x === 128 && decoded[1].y === 128,
    `(${decoded[1].x},${decoded[1].y})`);
  check("负坐标 mv 包装还原", decoded[3].x === 65530 && decoded[3].y === 65530,
    `(${decoded[3].x},${decoded[3].y})`);
  // nf=true 时败局仍标 NF 位
  const bytes2 = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: true, bbbv: 24, scoreCsec: 1, events: [], won: false,
  });
  const v2 = parseEvf(bytes2);
  check("败局 NF 位保留", v2.nf === true && !v2.isCompleted);
}

console.log("== 用例 4：时间倒退单调钳制 ==");
{
  const events: OnlineEvent[] = [
    ev(3, 16, 16, 200),
    ev(5, 16, 16, 260),
    ev(1, 32, 32, 100),  // mv 倒退 → 钳到 260
    ev(3, 32, 32, 320),
    ev(5, 32, 32, 400),
  ];
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24, scoreCsec: 70, events, won: true,
  });
  const v = parseEvf(bytes);
  const times = v.events.filter(e => e.mouse).map(e => e.time * 1000);
  check("钳制后单调不减", times.every((t, i) => i === 0 || t >= times[i - 1]), times.join(","));
  check("倒退事件钳到 260", times[2] === 260, times.join(","));
}

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
