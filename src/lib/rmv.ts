// RMV（Vienna Minesweeper Recorder）二进制 → RawVF 文本行
// 2026-10-16 从 flop 播放器 webpack 模块 3cab（RMVVideo）逆向移植。
// 站内 259 条 2022-2023 年 Vienna 录像此前无解析器（地图/回放/六维分析全缺）。
//
// 格式（对照 flop 3cab.readrmv 逐段验证，样本 217374 逐字节一致）：
//   头 4 字节 "*rmv"；int2 video type（恒 1）；
//   乱序 4 字节 int（n3 + n4*256 + n1*65536 + n2*2^24）；
//   int2 l（主串长）/ int2 m（版本串长）/ int2 ×2 / int2 c（初始旗标记）/ int2 v（扩展字段数）；
//   int / int2 / num；
//   l > 35：跳 (l-32) 字节 → 3 字节 3BV 字符（空格填充）→ 跳 16 字节 → 10 字节时间戳；
//   l ≤ 35：跳 (l-3) 字节（旧版无 3BV/时间戳）；
//   int2 → 18 字节程序名 → int3 → (m-22) 字节版本串 → num；
//   int2 f（玩家字段数）→ f>0 名字 / f>1 昵称 / f>2 国家 / f>3 token（各为 len+bytes）；
//   int → width(num) height(num) mines(int2) → 逐雷 (x,y) 两字节；
//   c>0：int2 初始旗数 → 逐旗 (x,y)（flop 合成为 time=0 的 rc+rr 对）；
//   qm(num) nf(num) mode(num) level(num 0/1/2) → (v-4) 个扩展 num；
//   事件流：num event；0=结束（后随 int）；1..7=鼠标（8 字节：time int3 + skip + x int2-12 + y int2-56）；
//     首事件 flop 拆成 press/release 对；8 非法；9..14 与 18..27 为 2 字节杂项；
//     15..17 终止（15=正常结束）。
//   鼠标码 1..7 = mv,lc,lr,rc,rr,mc,mr（与 flop 常量表一致）。
//
// 与 avf.ts 同款约定：无法识别返回 null；损坏抛 RmvParseError。

export class RmvParseError extends Error {}

const MOUSE_NAMES = ["mv", "lc", "lr", "rc", "rr", "mc", "mr"] as const;
/** 3BV 三字符段的最大长度（与头内 l 的语义联动：l>35 才有 3BV） */
const L_HAS_3BV = 35;

class RmvParser {
  private off = 0;
  private data: Uint8Array;

  // 头部字段
  private w = 0;
  private h = 0;
  private m = 0;
  private bbbv: number | null = null;
  private qm = false;
  private nf = false;
  private level = 0;
  private program = "";
  private version = "";
  private player = "";
  private board: number[] = [];
  private events: Array<{ ev: number; time: number; x: number; y: number }> = [];

  constructor(buf: Uint8Array) {
    this.data = buf;
  }

  private num(): number {
    if (this.off >= this.data.length) throw new RmvParseError("Unexpected end of data");
    return this.data[this.off++];
  }
  private int2(): number {
    return 256 * this.num() + this.num();
  }
  private int3(): number {
    return 65536 * this.num() + 256 * this.num() + this.num();
  }
  /** flop 基类的乱序小端 int（取值序 n1×65536 + n2×2^24 + n3 + n4×256） */
  private int(): number {
    const n1 = this.num();
    const n2 = this.num();
    const n3 = this.num();
    const n4 = this.num();
    return n3 + n4 * 256 + n1 * 65536 + n2 * 16777216;
  }
  private ch(): string {
    return String.fromCharCode(this.num());
  }

  parse(): boolean {
    // 头 4 字节
    if (this.data.length < 8) return false;
    for (const c of "*rmv") {
      if (this.ch() !== c) return false;
    }
    if (this.int2() !== 1) return false; // video type
    this.int();
    const l = this.int2();
    const m = this.int2();
    this.int2();
    this.int2();
    const c = this.int2();
    const v = this.int2();
    this.int();
    this.int2();
    this.num();

    if (l > L_HAS_3BV) {
      for (let i = 0; i < l - 32; i++) this.num();
      // 3BV 三字符（空格填充；乱码位按 flop 归一为空格）
      let s = "";
      for (let i = 0; i < 3; i++) {
        const c2 = this.ch();
        s += c2 >= "0" && c2 <= "9" ? c2 : " ";
      }
      const n = parseInt(s.trim(), 10);
      this.bbbv = Number.isFinite(n) && n > 0 ? n : null;
      for (let i = 0; i < 16; i++) this.num();
      let ts = "";
      for (let i = 0; i < 10; i++) ts += this.ch();
      void ts; // 时间戳不入 RawVF（与 avf 一致由库 create_time 为准）
    } else {
      for (let i = 0; i < l - 3; i++) this.num();
    }

    this.int2();
    for (let i = 0; i < 18; i++) this.program += this.ch();
    this.int3();
    for (let i = 0; i < m - 22; i++) this.version += this.ch();
    this.num();

    const f = this.int2();
    if (f > 0) {
      const n = this.num();
      const bytes: number[] = [];
      for (let i = 0; i < n; i++) bytes.push(this.num());
      // latin1 解码（浏览器端无 Buffer；Vienna 玩家名为 ASCII）
      this.player = bytes.map((b) => String.fromCharCode(b)).join("");
    }
    if (f > 1) {
      const n = this.num();
      for (let i = 0; i < n; i++) this.num();
    }
    if (f > 2) {
      const n = this.num();
      for (let i = 0; i < n; i++) this.num();
    }
    if (f > 3) {
      const n = this.num();
      for (let i = 0; i < n; i++) this.num();
    }

    this.int();
    this.w = this.num();
    this.h = this.num();
    this.m = this.int2();
    this.board = new Array(this.w * this.h).fill(0);
    for (let i = 0; i < this.m; i++) {
      const x = this.num();
      const y = this.num();
      if (x > this.w || y > this.h) throw new RmvParseError("Invalid mine position");
      this.board[y * this.w + x] = 1;
    }

    // 初始旗（标记开局录像）：flop 合成 time=0 的 rc+rr 对——保持同语义
    if (c) {
      const n = this.int2();
      for (let i = 0; i < n; i++) {
        const x = this.num();
        const y = this.num();
        const px = 8 + x * 16;
        const py = 8 + y * 16;
        this.events.push({ ev: 4, time: 0, x: px, y: py });
        this.events.push({ ev: 5, time: 0, x: px, y: py });
      }
    }

    this.qm = this.num() !== 0;
    this.nf = this.num() !== 0;
    const mode = this.num();
    this.level = this.num();
    void mode;
    for (let i = 4; i < v; i++) this.num();

    // 事件流
    let first = true;
    for (;;) {
      const ev = this.num();
      if (ev === 0) {
        this.int(); // 结束标记后的 4 字节
        break;
      }
      if (ev >= 1 && ev <= 7) {
        const time = this.int3();
        this.num();
        const x = this.int2() - 12;
        const y = this.int2() - 56;
        if (first) {
          // flop：首事件拆成 press(ev 改 2=lr)+release 对——无 press 的首事件引擎无法生效
          this.events.push({ ev: 2, time, x, y });
          this.events.push({ ev, time, x, y });
          first = false;
        } else {
          this.events.push({ ev, time, x, y });
        }
      } else if (ev === 8) {
        throw new RmvParseError("Invalid event");
      } else if (ev <= 14 || (ev >= 18 && ev <= 27)) {
        this.num();
        this.num();
      } else if (ev <= 17) {
        break;
      } else {
        throw new RmvParseError("Invalid event");
      }
    }
    return true;
  }

  /** 输出 RawVF 文本行（与 avf.ts toRawvfLines 同构，formatRawvf 直接消费） */
  toRawvfLines(): string[] {
    const levelNames = ["beginner", "intermediate", "expert", "custom"];
    const p2 = (n: number) => String(n).padStart(2, "0");
    const lines: string[] = [
      "RawVF_Version: Rev5",
      `Program: ${this.program}`,
      `Version: ${this.version}`,
      `Player: ${this.player}`,
      `Level: ${levelNames[this.level] ?? "custom"}`,
      `Width: ${this.w}`,
      `Height: ${this.h}`,
      `Mines: ${this.m}`,
      "Mode: classic",
    ];
    // 用时：RMV 无文件内成绩字段（SCORE 在主串里但不可靠），置 0 由上层以库 real_time 为准
    lines.push("Time: 0.00");
    if (this.bbbv !== null) lines.push(`3BV: ${this.bbbv}`);
    if (this.qm) lines.push("QuestionMarks: on");
    if (this.nf) lines.push("NF: on");
    lines.push("Board:");
    for (let y = 0; y < this.h; y++) {
      let row = "";
      for (let x = 0; x < this.w; x++) row += this.board[y * this.w + x] ? "*" : "0";
      lines.push(row);
    }
    lines.push("Events:");
    for (const e of this.events) {
      const name = MOUSE_NAMES[e.ev - 1];
      if (!name) continue;
      lines.push(
        `${(e.time / 1000).toFixed(3)} ${name} ${Math.trunc(e.x / 16) + 1} ${Math.trunc(e.y / 16) + 1} (${e.x} ${e.y})`
      );
    }
    return lines;
  }
}

/** 解析 RMV 文件为 RawVF 文本行；无法识别返回 null，损坏抛 RmvParseError */
export function rmvToRawvf(buf: Uint8Array): string[] | null {
  const parser = new RmvParser(buf);
  if (!parser.parse()) return null;
  return parser.toRawvfLines();
}
