// EVF（元扫雷格式，eee555's Minesweeper Video Format）解析器
// 按 evf 标准 v0.1–v0.4 移植，参考 ms-toollib（Rust）base/src/videos/evf_video.rs：
//   https://github.com/eee555/ms-toollib/blob/main/base/src/videos/evf_video.rs
//   https://github.com/eee555/ms_toollib/blob/main/evf%20format%20(evf%E6%A0%87%E5%87%86).md
//
// 要点（与 avf/mvf 的关键差异）：
//   - 整数一律大端（BE）；雷区位图 MSB-first（第 i*columns+j 位 = 第 i 行第 j 列）；
//   - v0.1–v0.3 事件流只含鼠标事件，绝对时间戳（u24 毫秒）+ 绝对像素坐标（u16），
//     流以 0x00（有校验和，固定 32 字节）或 0xFF（无校验和）终止；
//   - v0.4 事件流含鼠标/游戏状态/棋盘/指标/停顿五类事件，均为增量时间戳
//     （u8 毫秒，停顿事件 255 携带 u16 累计到下一事件）+ 增量坐标（i16）；
//   - v0.4 校验和为 u16 长度前缀 + 变长数据。标准未规定校验算法，仅原样保留供外部验证；
//   - pf 是"开局前标记"（不等价 rc+rr，记 right+1/flag+1）；
//     l/r/m 是方向未知的按压或松开（需鼠标状态机消歧），事件名原样保留。

import { renderBoard } from "./rawvf";

export class EvfParseError extends Error {}

export interface EvfEvent {
  /** 事件时间戳（秒，从第一次影响盘面的点击起累计；最后事件 ≥ 实际用时） */
  time: number;
  /** 鼠标事件类型：mv/lc/lr/rc/rr/mc/mr/pf/cc/l/r/m */
  mouse?: string;
  /** 游戏状态事件：replay/win/fail/error（v0.4+） */
  gameState?: string;
  /** 棋盘事件（v0.4+）：类型名 + 单元格坐标增量 */
  boardEvent?: { type: string; dx: number; dy: number };
  /** 指标事件（v0.4+）：自定义指标赋值 */
  metric?: { index: number; kind: "number" | "string"; num?: number; str?: string };
  /** 停顿事件（v0.4+）：到下一事件的暂停毫秒数（含累计） */
  pause?: number;
  /** 坐标（像素，鼠标事件专用；盘外 = 列数×格子边长 / 行数×格子边长） */
  x?: number;
  y?: number;
}

export interface EvfVideo {
  version: number; // 1..4
  // —— 摘要位（byte 2）——
  isCompleted: boolean;
  isOfficial: boolean;
  isFair: boolean;
  nf: boolean;
  /** 是否转码录像（v0.4 摘要位；旧版本按 software 是否以"元"开头推断） */
  translated: boolean;
  // —— 设置位（v0.3+，byte 3）——
  /** 1 = 已禁用问号 */
  useQuestion: boolean;
  /** 1 = 指针不可越出盘面 */
  useCursorPosLim: boolean;
  /** 1 = 触雷自动重开 */
  useAutoRestart: boolean;
  // —— 盘面 ——
  height: number;
  width: number;
  mines: number;
  /** beg / int / exp / custom */
  level: string;
  cellPixelSize: number;
  mode: number;
  modeName: string;
  bbbv: number;
  /** 实际用时（毫秒） */
  rtimeMs: number;
  country: string;
  /** 开始时间戳（微秒，Unix 纪元；无法解析的转码来源为 null） */
  startTime: number | null;
  /** 结束时间戳（微秒，Unix 纪元） */
  endTime: number | null;
  software: string;
  /** 转码软件名（仅 v0.4 转码录像） */
  translateSoftware: string;
  /** 原始编码（仅 v0.4 转码录像） */
  originalEncoding: string;
  /** 玩家标识 */
  playerIdentifier: string;
  /** 赛事标识 */
  raceIdentifier: string;
  /** 唯一标识 */
  uniqueIdentifier: string;
  /** 设备 UUID（hex） */
  deviceUuid: string;
  /** 整盘棋盘串：'*' 或八邻域雷数（复用 rawvf 的 renderBoard） */
  board: string;
  /** 原始位图行（'*'/'0'，每行 width 个字符）——evfToRawvf 组 Board 行用 */
  grid: string[];
  events: EvfEvent[];
  /** 校验和（hex） */
  checksum: string;
}

// 游戏模式名（v0.3/v0.4 标准）
const MODE_NAMES: Record<number, string> = {
  0: "standard",
  1: "upk",
  2: "cheat",
  3: "density",
  4: "win7",
  5: "competitive-solvable",
  6: "strong-solvable",
  7: "weak-solvable",
  8: "to-be-solvable",
  9: "strong-guessable",
  10: "weak-guessable",
  11: "chording-recursive",
  12: "flag-recursive",
  13: "chording-flag-recursive",
  14: "solvable-chording-recursive",
  15: "solvable-flag-recursive",
  16: "solvable-chording-flag-recursive",
  65535: "no-rule",
};

const MOUSE_NAMES: Record<number, string> = {
  1: "mv",
  2: "lc",
  3: "lr",
  4: "rc",
  5: "rr",
  6: "mc",
  7: "mr",
  8: "pf",
  9: "cc",
  10: "l",
  11: "r",
  12: "m",
};

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// 棋盘事件类型名（v0.4 标准）
const BOARD_EVENT_NAMES: Record<number, string> = {
  100: "cell_0",
  101: "cell_1",
  102: "cell_2",
  103: "cell_3",
  104: "cell_4",
  105: "cell_5",
  106: "cell_6",
  107: "cell_7",
  108: "cell_8",
  110: "up",
  111: "flag",
  114: "cross_mine",
  115: "blast",
  116: "mine",
  118: "pressed",
  120: "questionmark",
  121: "pressed_questionmark",
};

const GAME_STATE_NAMES: Record<number, string> = {
  81: "replay",
  82: "win",
  83: "fail",
  99: "error",
};

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.buf.length) throw new EvfParseError("Unexpected end of file");
    return this.buf[this.pos++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u24(): number {
    return ((this.u16() << 8) | this.u8()) >>> 0;
  }
  u32(): number {
    return ((this.u16() << 16) | this.u16()) >>> 0;
  }
  u64(): number {
    // 时间戳量级 ~1.8e15 < 2^53，Number 安全
    return this.u32() * 4294967296 + this.u32();
  }
  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  f64(): number {
    const bytes = this.bytes(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0);
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new EvfParseError("Unexpected end of file");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** 以 '\0' 结尾的 utf-8 字符串 */
  cstr(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) throw new EvfParseError("Unterminated string");
    const s = new TextDecoder("utf-8").decode(this.buf.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }
  fixedString(n: number): string {
    return new TextDecoder("utf-8").decode(this.bytes(n));
  }
}

/** v0.1–v0.3：按来源软件解析开始/结束时间戳（字符串形态） */
function parseLegacyTimestamps(
  software: string,
  startStr: string,
  endStr: string,
  rtimeMs: number,
): [number | null, number | null] {
  if (software.startsWith("元")) {
    const s = Number(startStr);
    const e = Number(endStr);
    return Number.isFinite(s) && Number.isFinite(e) ? [s, e] : [null, null];
  }
  if (software === "Viennasweeper") {
    const s = Number(startStr);
    return Number.isFinite(s) ? [s * 1e6, s * 1e6 + rtimeMs * 1000] : [null, null];
  }
  // Arbiter 等转码来源：avf 日期格式，解析复杂且罕见，暂不展开
  return [null, null];
}

function levelOf(h: number, w: number, mines: number): string {
  if (h === 8 && w === 8 && mines === 10) return "beg";
  if (h === 16 && w === 16 && mines === 40) return "int";
  if (h === 16 && w === 30 && mines === 99) return "exp";
  return "custom";
}

export function parseEvf(buf: Uint8Array): EvfVideo {
  const r = new Reader(buf);
  const version = r.u8();
  if (version < 1 || version > 4) {
    throw new EvfParseError(`Unsupported evf version: ${version}`);
  }

  const summary = r.u8();
  const isCompleted = (summary & 0b1000_0000) !== 0;
  const isOfficial = (summary & 0b0100_0000) !== 0;
  const isFair = (summary & 0b0010_0000) !== 0;
  const nf = (summary & 0b0001_0000) !== 0;

  let useQuestion = false;
  let useCursorPosLim = false;
  let useAutoRestart = false;
  if (version >= 3) {
    const settings = r.u8();
    useQuestion = (settings & 0b1000_0000) !== 0;
    useCursorPosLim = (settings & 0b0100_0000) !== 0;
    useAutoRestart = (settings & 0b0010_0000) !== 0;
  }

  const height = r.u8();
  const width = r.u8();
  const mines = r.u16();
  const cellPixelSize = r.u8();
  const mode = r.u16();
  const bbbv = r.u16();
  const rtimeMs = version >= 4 ? r.u32() : r.u24();

  let country: string;
  let startTime: number | null;
  let endTime: number | null;
  let software: string;
  let translateSoftware = "";
  let originalEncoding = "";
  let playerIdentifier = "";
  let raceIdentifier = "";
  let uniqueIdentifier = "";
  let deviceUuid = "";

  if (version >= 4) {
    // v0.4：国家固定 2 字节；时间戳为 uint64 微秒；UUID 为 u16 长度前缀
    country = r.fixedString(2);
    startTime = r.u64();
    endTime = r.u64();
    software = r.cstr();
    if ((summary & 0b0000_1000) !== 0) {
      translateSoftware = r.cstr();
      originalEncoding = r.cstr();
    }
    playerIdentifier = r.cstr();
    raceIdentifier = r.cstr();
    uniqueIdentifier = r.cstr();
    const uuidLen = r.u16();
    deviceUuid = toHex(r.bytes(uuidLen));
  } else {
    software = r.cstr();
    playerIdentifier = r.cstr();
    raceIdentifier = r.cstr();
    uniqueIdentifier = r.cstr();
    const startStr = r.cstr();
    const endStr = r.cstr();
    country = r.cstr();
    if (version >= 2) {
      // v0.2/v0.3：设备 UUID 为 '\0' 结尾字符串（多为可读 ASCII，原样保留）
      deviceUuid = r.cstr();
    }
    [startTime, endTime] = parseLegacyTimestamps(software, startStr, endStr, rtimeMs);
  }

  // —— 雷区位图（MSB-first，共 ⌈行×列/8⌉ 字节，循环内按需取字节）——
  const grid: string[] = [];
  let bitPtr = 0;
  let byte = 0;
  for (let i = 0; i < height; i++) {
    let row = "";
    for (let j = 0; j < width; j++) {
      if (bitPtr === 0) {
        byte = r.u8();
        bitPtr = 8;
      }
      bitPtr -= 1;
      row += byte & (1 << bitPtr) ? "*" : "0";
    }
    grid.push(row);
  }

  // —— 自定义指标键名（v0.4+：u16 数量 + '\0' 结尾键名列表）——
  // 目前没有站点使用，仅按结构跳过；指标事件里的下标即对应此处的键名序号
  if (version >= 4) {
    const customCount = r.u16();
    for (let i = 0; i < customCount; i++) r.cstr();
  }

  // —— 事件流 ——
  const events: EvfEvent[] = [];
  let lastX = 0;
  let lastY = 0;
  let lastTimeMs = 0;
  let pauseMs = 0;
  let checksumPresent: boolean;

  if (version >= 4) {
    while (true) {
      const t = r.u8();
      if (t === 0) break; // 事件流结束符
      if (t >= 1 && t <= 12) {
        // 鼠标事件：u8 时间增量 + i16 列增量 + i16 行增量（坐标增量相对上一鼠标事件）
        const dt = r.u8();
        const dx = r.i16();
        const dy = r.i16();
        const x = (lastX + dx) & 0xffff;
        const y = (lastY + dy) & 0xffff;
        const timeMs = lastTimeMs + dt + pauseMs;
        pauseMs = 0;
        lastX = x;
        lastY = y;
        lastTimeMs = timeMs;
        events.push({ time: timeMs / 1000, mouse: MOUSE_NAMES[t], x, y });
      } else if (t >= 81 && t <= 99) {
        const gameState = GAME_STATE_NAMES[t];
        if (!gameState) throw new EvfParseError(`Unknown game state event: ${t}`);
        const timeMs = lastTimeMs + r.u8() + pauseMs;
        pauseMs = 0;
        lastTimeMs = timeMs;
        events.push({ time: timeMs / 1000, gameState });
      } else if (t >= 100 && t <= 199) {
        // 棋盘事件：u8 时间增量 + i16 列增量 + i16 行增量（单元格坐标，盘外=列数/行数）
        // ms-toollib 参考实现暂不解析此类事件，Metasweeper 目前不产出；按标准文档展开
        const name = BOARD_EVENT_NAMES[t] ?? `unknown_${t}`;
        const timeMs = lastTimeMs + r.u8() + pauseMs;
        const dx = r.i16();
        const dy = r.i16();
        pauseMs = 0;
        lastTimeMs = timeMs;
        events.push({ time: timeMs / 1000, boardEvent: { type: name, dx, dy } });
      } else if (t >= 200 && t <= 254) {
        // 指标事件：u8 时间增量 + u16 (指标下标+10000) + float64 或 '\0' 结尾字符串
        const timeMs = lastTimeMs + r.u8() + pauseMs;
        const idxRaw = r.u16();
        pauseMs = 0;
        lastTimeMs = timeMs;
        const index = idxRaw - 10000;
        if (idxRaw >= 20000) {
          events.push({ time: timeMs / 1000, metric: { index, kind: "string", str: r.cstr() } });
        } else {
          events.push({ time: timeMs / 1000, metric: { index, kind: "number", num: r.f64() } });
        }
      } else if (t === 255) {
        // 停顿事件：u16 毫秒增量，累计到下一事件的时间戳
        pauseMs += r.u16();
        events.push({ time: lastTimeMs / 1000, pause: pauseMs });
      } else {
        throw new EvfParseError(`Unknown event type ${t} at offset ${r.pos - 1}`);
      }
    }
    checksumPresent = true; // v0.4 恒有校验和段
  } else {
    // v0.1–v0.3：事件流只有鼠标事件，绝对时间戳 + 绝对坐标
    while (true) {
      const t = r.u8();
      if (t === 0) {
        checksumPresent = true; // 0x00 = 有校验和（固定 32 字节）
        break;
      }
      if (t === 255) {
        checksumPresent = false; // 0xFF = 无校验和（如 avf 转码而来）
        break;
      }
      const mouse = MOUSE_NAMES[t];
      if (!mouse) throw new EvfParseError(`Unknown event type ${t} at offset ${r.pos - 1}`);
      const timeMs = r.u24();
      const x = r.u16();
      const y = r.u16();
      lastX = x;
      lastY = y;
      lastTimeMs = timeMs;
      events.push({ time: timeMs / 1000, mouse, x, y });
    }
  }

  // —— 校验和 ——
  let checksum = "";
  if (checksumPresent) {
    const n = version >= 4 ? r.u16() : 32;
    checksum = toHex(r.bytes(n));
  }

  const translated = version >= 4 ? (summary & 0b0000_1000) !== 0 : !software.startsWith("元");

  return {
    version,
    isCompleted,
    isOfficial,
    isFair,
    nf,
    translated,
    useQuestion,
    useCursorPosLim,
    useAutoRestart,
    height,
    width,
    mines,
    level: levelOf(height, width, mines),
    cellPixelSize,
    mode,
    modeName: MODE_NAMES[mode] ?? `mode_${mode}`,
    bbbv,
    rtimeMs,
    country,
    startTime,
    endTime,
    software,
    translateSoftware,
    originalEncoding,
    playerIdentifier,
    raceIdentifier,
    uniqueIdentifier,
    deviceUuid,
    board: renderBoard(grid),
    grid,
    events,
    checksum,
  };
}

/**
 * EVF → RawVF 文本行（与 avf/rmv 转换器同构，formatRawvf 直接消费）。
 * 关键折算：全站下游（judgeVideoOutcome / 回放引擎 / Path 统计）一律 16px 格子口径，
 * evf 的像素坐标按 cellPixelSize 等比折算到 16px；必须向下取整，四舍五入会让
 * 格边附近的指针提前跨进相邻格（48px 样例曾因此误判 incomplete/loss）。
 * 事件名映射（标准文档「不推荐」码的消歧）：
 *   mv/lc/lr/rc/rr/mc/mr 直通；
 *   pf（开局前标记）→ rc+rr 对（等价插旗，right+1/flag+1）；
 *   cc（双击按下，按钮未知）→ sc（shift 语义置 sv，chord 在其后的 lr/松开生效）。
 *     ⚠️ 不能映射成 mc（仅视觉）：Metasweeper 录制双击=「按下键(lc/rc) → cc → 松开(lr/rr)」，
 *     光标下的双击 chord 依赖 cc 置位——用 mc 会让左键按住的双击（lc→cc→lr）丢 chord
 *     （样例实测 17 次双击失效、32 格缺口、误判 incomplete）；cc→sc 后 381/381 WIN。
 *   l/r/m（方向未知）→ 有限状态机消歧（按当前按下状态判定按压/松开）。
 * 棋盘事件/指标事件无站点产出，直接跳过；停顿已折进时间戳累计。
 *
 * 负值修正（2026-10-24，347107 排查结论）：evf 时间轴 0 点＝最早影响盘面的
 * 左键「按下」（lc），而计时起点＝第一个 lr 且其位置不是已标雷（开局前插的旗、
 * 点在旗上的 lr 都不算开始——张老师定口径）。全站时间口径（页面成绩/库内
 * real_time）取头文件 rtime（计时起点基准），事件流须整体平移 -t0 对齐：
 * 开局前事件（按下未弹起、pre-game 标旗）得负时间。不平移的话，回放终点/
 * 胜利时刻会比成绩多出这段「按下未弹起」时间（347107 实测差 64ms：事件流
 * 尾 65.480s vs 成绩 65.416s，恰好等于首个 lc→lr 间隔）。
 */
export function evfToRawvf(buf: Uint8Array): string[] {
  const v = parseEvf(buf);
  // 软件名归一：Metasweeper 在 Software 字段自报「元3.3.4」，展示口径统一为「元扫雷3.3.4」
  const program =
    v.software.startsWith("元") && !v.software.startsWith("元扫雷")
      ? `元扫雷${v.software.slice(1)}`
      : v.software;
  const lines: string[] = [
    "RawVF_Version: Rev5",
    `Program: ${program}`,
    `Version: 0.${v.version}`,
    // 玩家标识可能为空（靠 UUID 区分身份的录法），逐级兜底防止空签名入库
    `Player: ${v.playerIdentifier || v.uniqueIdentifier || "元扫雷玩家"}`,
    `Level: ${v.level === "beg" ? "beginner" : v.level === "int" ? "intermediate" : v.level === "exp" ? "expert" : "custom"}`,
    `Width: ${v.width}`,
    `Height: ${v.height}`,
    `Mines: ${v.mines}`,
    // mode≠0（upk/cheat/…）时写真实模式名，formatRawvf 透传后被上传校验的 classic 检查拒绝
    `Mode: ${v.mode === 0 ? "classic" : v.modeName}`,
    `Time: ${(v.rtimeMs / 1000).toFixed(3)}`,
    `3BV: ${v.bbbv}`,
  ];
  // settings bit0x80 = use_question（1=开启问号）——官方写入端 `if use_question |= 0b1000_0000`、
  // 解析端 `use_question = bit != 0`、base_video 默认 false（「禁用问号是共识」）。
  // evf标准.md 写的「1 表示关闭」是文档错误（全库 evf 无一置位，若按文档则全站问号开启，显然荒谬）。
  // RawVF 的 QuestionMarks: on = 问号开启
  if (v.useQuestion) lines.push("QuestionMarks: on");
  lines.push("Board:");
  for (const row of v.grid) lines.push(row);
  lines.push("Events:");

  // 像素折算：evf 像素 → 16px 口径像素
  const cell = v.cellPixelSize || 16;
  const px = (p: number) => Math.floor((p * 16) / cell);
  const line = (t: number, name: string, x: number, y: number) =>
    `${t.toFixed(3)} ${name} ${Math.trunc(px(x) / 16) + 1} ${Math.trunc(px(y) / 16) + 1} (${px(x)} ${px(y)})`;

  // —— 负值修正：t0＝第一个 lr 且其位置不是已标雷（计时起点）；开局前事件得负时间 ——
  // 开局前无已开格，旗状态只需跟踪 pf/rc（rc 开局前＝toggleLabel 插/摘旗）；
  // lr 点在已标雷上＝无效操作不算开始（flop open() 跳过 flagged，同语义）。
  let t0Ms = 0;
  {
    const flagged = new Set<number>();
    outer: for (const e of v.events) {
      if (!e.mouse) continue;
      const key = Math.trunc(px(e.x ?? 0) / 16) * 1024 + Math.trunc(px(e.y ?? 0) / 16);
      switch (e.mouse) {
        case "pf":
          flagged.add(key);
          break;
        case "rc":
          if (flagged.has(key)) flagged.delete(key);
          else flagged.add(key);
          break;
        case "lr":
          if (!flagged.has(key)) {
            t0Ms = Math.round(e.time * 1000);
            break outer;
          }
          break;
        // lc/mv/cc/rr：开局前无盘面效果，不影响计时起点
      }
    }
  }
  const t0Sec = t0Ms / 1000;

  // l/r/m 消歧状态机（转码录像可能产出）
  let lDown = false;
  let rDown = false;
  let mDown = false;
  for (const e of v.events) {
    if (!e.mouse) continue; // 游戏状态/棋盘/指标/停顿事件不进事件流
    const x = e.x ?? 0;
    const y = e.y ?? 0;
    switch (e.mouse) {
      case "l":
        if (lDown) {
          lDown = false;
          lines.push(line(e.time - t0Sec, "lr", x, y));
        } else {
          lDown = true;
          lines.push(line(e.time - t0Sec, "lc", x, y));
        }
        break;
      case "r":
        if (rDown) {
          rDown = false;
          lines.push(line(e.time - t0Sec, "rr", x, y));
        } else {
          rDown = true;
          lines.push(line(e.time - t0Sec, "rc", x, y));
        }
        break;
      case "m":
        if (mDown) {
          mDown = false;
          lines.push(line(e.time - t0Sec, "mr", x, y));
        } else {
          mDown = true;
          lines.push(line(e.time - t0Sec, "mc", x, y));
        }
        break;
      case "pf":
        // 开局前标记：等价一次插旗（按下+松开同拍）
        lines.push(line(e.time - t0Sec, "rc", x, y));
        lines.push(line(e.time - t0Sec, "rr", x, y));
        break;
      case "cc":
        // 双击按下（按钮未知）：sc 语义置 sv，chord 在其后的 lr（或按住左键时的 rr）生效
        lines.push(line(e.time - t0Sec, "sc", x, y));
        break;
      default:
        lines.push(line(e.time - t0Sec, e.mouse, x, y));
    }
  }
  return lines;
}
