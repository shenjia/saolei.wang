// MVF 解析器：忠实移植 vendors/RawVF/mvf_parser.c（594 行 C）
// 输入 MVF 二进制，输出 RawVF 文本行（再经 rawvf.ts 的 formatRawvf 结构化）
// 与 C 版的唯一刻意差异：玩家名在输出前已从 gb2312 解码为 utf-8
// （PHP 在 Parser::format 里做同样的转换，最终状态一致）

const MAXREP = 100000;
const SQUARE_SIZE = 16;

export class MvfParseError extends Error {}

interface MvfEvent {
  sec: number;
  ths: number;
  x: number;
  y: number;
  lb: number;
  rb: number;
  mb: number;
}

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  u8(): number {
    if (this.pos >= this.buf.length) throw new MvfParseError("Unexpected end of file");
    return this.buf[this.pos++];
  }
  /** 大端 2 字节（C 的 getint2：c[1] + c[0]*256） */
  int2(): number {
    return this.u8() * 256 + this.u8();
  }
  /** 大端 3 字节 */
  int3(): number {
    return this.u8() * 65536 + this.u8() * 256 + this.u8();
  }
  seek(pos: number) {
    this.pos = pos;
  }
  get length() {
    return this.buf.length;
  }
}

/** C 的 sprintf("%08d", (int)lrint(x)) */
function fmt8(x: number): string {
  return String(Math.round(x)).padStart(8, "0");
}

/** gb2312 玩家名解码（对应 PHP mb_convert_encoding(..., 'gb2312')；gb18030 是其超集） */
const gbkDecoder = new TextDecoder("gb18030");
function decodeName(bytes: number[]): string {
  return gbkDecoder.decode(new Uint8Array(bytes));
}

class MvfParser {
  private r: Reader;
  private mode = 0;
  private level = 0;
  private w = 0;
  private h = 0;
  private m = 0;
  private board: number[] = [];
  private qm = 0;
  private hasDate = 0;
  private hasInfo = 0;
  private month = 0;
  private year = 0;
  private day = 0;
  private hour = 0;
  private minute = 0;
  private second = 0;
  private bbbv = 0;
  private solvedBbbv = 0;
  private lcl = 0;
  private rcl = 0;
  private dcl = 0;
  private scoreSec = 0;
  private scoreThs = 0;
  private name = "";
  private version = "";
  private video: MvfEvent[] = [];

  constructor(buf: Buffer) {
    this.r = new Reader(buf);
  }

  private readBoard(add: number) {
    const r = this.r;
    this.w = r.u8();
    this.h = r.u8();
    const boardSz = this.w * this.h;
    this.board = new Array(boardSz).fill(0);
    this.m = r.u8() * 256 + r.u8();
    for (let i = 0; i < this.m; i++) {
      const pos = r.u8() + add + (r.u8() + add) * this.w;
      if (pos >= boardSz || pos < 0) throw new MvfParseError("Invalid mine position");
      this.board[pos] = 1;
    }
  }

  private readScore() {
    const r = this.r;
    this.scoreSec = r.u8() * 256 + r.u8();
    this.scoreThs = 10 * r.u8();
  }

  /** 0.97 的 40bit 乱序表（C read_097 的 leading 字节排列算法） */
  private static perm40(leading: number): { byte: number[]; bit: number[] } {
    const num1 = Math.sqrt(leading);
    const num2 = Math.sqrt(leading + 1000.0);
    const num3 = Math.sqrt(num1 + 1000.0);
    const mult = 100000000;
    const s =
      fmt8(Math.abs(Math.cos(num3 + 1000.0) * mult)) +
      fmt8(Math.abs(Math.sin(Math.sqrt(num2)) * mult)) +
      fmt8(Math.abs(Math.cos(num3) * mult)) +
      fmt8(Math.abs(Math.sin(Math.sqrt(num1) + 1000.0) * mult)) +
      fmt8(Math.abs(Math.cos(Math.sqrt(num2 + 1000.0)) * mult));
    const byte: number[] = [];
    const bit: number[] = [];
    for (let ch = 48; ch <= 57; ch++) {
      for (let j = 0; j < 40; j++) {
        if (s.charCodeAt(j) === ch) {
          byte.push(j >> 3);
          bit.push(1 << (j % 8));
        }
      }
    }
    return { byte, bit };
  }

  /** 2006/2007 的 48bit 乱序表 */
  private static perm48(leading: number): { byte: number[]; bit: number[] } {
    const num1 = Math.sqrt(leading);
    const num2 = Math.sqrt(leading + 1000.0);
    const num3 = Math.sqrt(num1 + 1000.0);
    const num4 = Math.sqrt(num2 + 1000.0);
    const mult = 100000000;
    const s =
      fmt8(Math.abs(Math.cos(num3 + 1000.0) * mult)) +
      fmt8(Math.abs(Math.sin(Math.sqrt(num2)) * mult)) +
      fmt8(Math.abs(Math.cos(num3) * mult)) +
      fmt8(Math.abs(Math.sin(Math.sqrt(num1) + 1000.0) * mult)) +
      fmt8(Math.abs(Math.cos(num4) * mult)) +
      fmt8(Math.abs(Math.sin(num4) * mult));
    const byte: number[] = [];
    const bit: number[] = [];
    for (let ch = 48; ch <= 57; ch++) {
      for (let j = 0; j < 48; j++) {
        if (s.charCodeAt(j) === ch) {
          byte.push(j >> 3);
          bit.push(1 << (j % 8));
        }
      }
    }
    return { byte, bit };
  }

  private static bitOf(e: number[], perm: { byte: number[]; bit: number[] }, num: number): number {
    return e[perm.byte[num]] & perm.bit[num] ? 1 : 0;
  }

  private read097(): void {
    const r = this.r;
    this.hasDate = this.hasInfo = 1;
    this.month = r.u8();
    this.day = r.u8();
    this.year = r.int2();
    this.hour = r.u8();
    this.minute = r.u8();
    this.second = r.u8();
    this.level = r.u8();
    this.mode = r.u8();
    this.readScore();
    this.bbbv = r.int2();
    this.solvedBbbv = r.int2();
    this.lcl = r.int2();
    this.dcl = r.int2();
    this.rcl = r.int2();
    this.qm = r.u8();
    this.readBoard(-1);
    const len = r.u8();
    const nameBytes: number[] = [];
    for (let i = 0; i < len; i++) nameBytes.push(r.u8());
    this.name = decodeName(nameBytes);

    const leading = r.int2();
    const perm = MvfParser.perm40(leading);
    const size = r.int3();
    if (size >= MAXREP) throw new MvfParseError("Too large video");
    for (let i = 0; i < size; i++) {
      const e = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
      const ev: MvfEvent = { sec: 0, ths: 0, x: 0, y: 0, lb: 0, rb: 0, mb: 0 };
      ev.rb = MvfParser.bitOf(e, perm, 0);
      ev.mb = MvfParser.bitOf(e, perm, 1);
      ev.lb = MvfParser.bitOf(e, perm, 2);
      for (let j = 0; j < 9; j++) {
        ev.x |= MvfParser.bitOf(e, perm, 12 + j) << j;
        ev.y |= MvfParser.bitOf(e, perm, 3 + j) << j;
      }
      for (let j = 0; j < 7; j++) ev.ths |= MvfParser.bitOf(e, perm, 21 + j) << j;
      ev.ths *= 10;
      for (let j = 0; j < 10; j++) ev.sec |= MvfParser.bitOf(e, perm, 28 + j) << j;
      this.video.push(ev);
    }
  }

  private read2007(): void {
    const r = this.r;
    this.hasDate = 1;
    this.hasInfo = 0;
    this.month = r.u8();
    this.day = r.u8();
    this.year = r.int2();
    this.hour = r.u8();
    this.minute = r.u8();
    this.second = r.u8();
    this.level = r.u8();
    this.mode = r.u8();
    const totalMs = r.int3();
    this.scoreSec = Math.floor(totalMs / 1000);
    this.scoreThs = totalMs % 1000;
    this.qm = r.u8();
    this.readBoard(-1);
    let len = r.u8();
    if (len >= 1000) len = 999;
    const nameBytes: number[] = [];
    for (let i = 0; i < len; i++) nameBytes.push(r.u8());
    this.name = decodeName(nameBytes);

    const leading = r.int2();
    const perm = MvfParser.perm48(leading);
    const size = r.int3();
    if (size >= MAXREP) throw new MvfParseError("Too large video");
    for (let i = 0; i < size; i++) {
      const e = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
      const ev: MvfEvent = { sec: 0, ths: 0, x: 0, y: 0, lb: 0, rb: 0, mb: 0 };
      ev.rb = MvfParser.bitOf(e, perm, 0);
      ev.mb = MvfParser.bitOf(e, perm, 1);
      ev.lb = MvfParser.bitOf(e, perm, 2);
      for (let j = 0; j < 11; j++) {
        ev.x |= MvfParser.bitOf(e, perm, 14 + j) << j;
        ev.y |= MvfParser.bitOf(e, perm, 3 + j) << j;
      }
      for (let j = 0; j < 22; j++) ev.ths |= MvfParser.bitOf(e, perm, 25 + j) << j;
      ev.sec = Math.floor(ev.ths / 1000);
      ev.ths %= 1000;
      ev.x -= 32;
      ev.y -= 32;
      this.video.push(ev);
    }
  }

  /** pre-0.97：无固定头，棋盘开头 + 8 字节事件流 + 尾部成绩/名字/校验和 */
  private readPre097(): void {
    const r = this.r;
    r.seek(0);
    this.readBoard(0);
    this.qm = r.u8();
    r.u8();
    let current = r.pos;
    const filesize = r.length;
    r.seek(filesize - 1);
    const last = r.u8();

    let afterEvents: number;
    let hasName: boolean;
    if (last) {
      // 末字节非 0：0.8 以前，无 20 字节校验和
      r.seek(filesize - 13);
      if (r.u8() === 0x20 && r.u8() === 0x20 && r.u8() === 0x20) {
        this.version = "0.76";
        afterEvents = filesize - 113;
        hasName = true;
      } else {
        this.name = "";
        this.version = "<=0.75";
        afterEvents = filesize - 13;
        hasName = false;
      }
    } else {
      this.version = "<=0.96";
      afterEvents = filesize - 125;
      hasName = true;
    }
    this.hasInfo = this.hasDate = 0;
    this.mode = 1; // 早期 Clone 只存经典模式
    if (this.w === 8 && this.h === 8) this.level = 1;
    else if (this.w === 16 && this.h === 16) this.level = 2;
    else if (this.w === 30 && this.h === 16) this.level = 3;
    else throw new MvfParseError("Invalid board size");

    r.seek(afterEvents);
    this.readScore();
    if (hasName) {
      const nameBytes: number[] = [];
      for (let i = 0; i < 100; i++) nameBytes.push(r.u8());
      // 去掉尾部空格
      while (nameBytes.length && nameBytes[nameBytes.length - 1] === 0x20) nameBytes.pop();
      this.name = decodeName(nameBytes);
    }

    // 读事件流：时间回退或超过成绩时间即止（C 的 while(current<=after_events) + break 条件）
    r.seek(current);
    const size0 = this.video.length;
    while (current <= afterEvents) {
      const e = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
      const ev: MvfEvent = {
        sec: e[0],
        ths: e[1] * 10,
        lb: e[2] & 0x01,
        mb: e[2] & 0x02,
        rb: e[2] & 0x04,
        x: e[3] * 256 + e[4],
        y: e[5] * 256 + e[6],
      };
      const n = this.video.length;
      if (n > size0) {
        const prev = this.video[n - 1];
        if (ev.sec < prev.sec || (ev.sec === prev.sec && ev.ths < prev.ths)) break;
      }
      if (ev.sec > this.scoreSec || (ev.sec === this.scoreSec && ev.ths > this.scoreThs)) break;
      this.video.push(ev);
      current += 8;
      if (this.video.length >= MAXREP) throw new MvfParseError("Too large video");
    }

    // C 在末尾补一个「全部按键松开」的合成事件
    const lastEv = this.video[this.video.length - 1];
    if (!lastEv) throw new MvfParseError("Invalid MVF");
    this.video.push({ sec: lastEv.sec, ths: lastEv.ths, x: lastEv.x, y: lastEv.y, lb: 0, mb: 0, rb: 0 });
    if (this.video.length >= MAXREP) throw new MvfParseError("Too large video");
  }

  parse(): boolean {
    const r = this.r;
    const c = r.u8();
    const d = r.u8();
    if (c === 0x11 && d === 0x4d) {
      // 0.97+：offset 27 是发布年份字符串的末位
      r.seek(27);
      const yc = r.u8();
      if (yc === 0x35) {
        // '5' → 0.97
        r.seek(74);
        this.version = "0.97";
        this.read097();
        return true;
      } else if (yc === 0x36 || yc === 0x37) {
        // '6'/'7' → 2006/2007
        r.seek(53);
        const vlen = r.u8();
        const vbytes: number[] = [];
        for (let i = 0; i < vlen; i++) vbytes.push(r.u8());
        this.version = decodeName(vbytes);
        r.seek(71);
        this.read2007();
        return true;
      } else if (yc === 0x38) {
        // '8' → funny mode（全是 UPK）
        r.seek(74);
        this.version = "funny mode";
        this.read097();
        this.mode = 3;
        return true;
      }
      return false;
    } else if (c === 0x00 && d === 0x00) {
      // 丢了头部信息的 0.97
      r.seek(7);
      this.version = "0.97 lost head";
      this.read097();
      return true;
    } else {
      this.readPre097();
      return true;
    }
  }

  /** writetxt：输出 RawVF 文本行（与 C 版逐行一致，玩家名为解码后的 utf-8） */
  toRawvfLines(): string[] {
    const levelNames = ["", "beginner", "intermediate", "expert", "custom", "custom"];
    const modeNames = ["", "classic", "density", "UPK", "cheat"];
    const level = Math.min(this.level, 5);
    const mode = Math.min(this.mode, 4);

    const lines: string[] = [
      "RawVF_Version: Rev5",
      "Program: Minesweeper Clone",
      `Version: ${this.version}`,
      `Player: ${this.name}`,
      `Level: ${levelNames[level]}`,
      `Width: ${this.w}`,
      `Height: ${this.h}`,
      `Mines: ${this.m}`,
      `Mode: ${modeNames[mode]}`,
      `Time: ${this.scoreSec}.${String(this.scoreThs).padStart(3, "0")}`,
    ];
    if (this.qm) lines.push("Marks: on");
    if (this.hasDate) {
      const p2 = (n: number) => String(n).padStart(2, "0");
      lines.push(
        this.day
          ? `Timestamp: ${this.year}-${p2(this.month)}-${p2(this.day)} ${p2(this.hour)}:${p2(this.minute)}:${p2(this.second)}`
          : `Timestamp: ${this.year}-${p2(this.month)}-?? ${p2(this.hour)}:${p2(this.minute)}:${p2(this.second)}`
      );
    }
    if (this.hasInfo) {
      lines.push(`3BV: ${this.bbbv}`);
      lines.push(`Solved3BV: ${this.solvedBbbv}`);
      lines.push(`LeftClicks: ${this.lcl}`);
      lines.push(`RightClicks: ${this.rcl}`);
      lines.push(`DoubleClicks: ${this.dcl}`);
    }
    lines.push("Board:");
    for (let y = 0; y < this.h; y++) {
      let row = "";
      for (let x = 0; x < this.w; x++) row += this.board[y * this.w + x] ? "*" : "0";
      lines.push(row);
    }
    lines.push("Events:");
    lines.push("0.000 start");

    const cell = (e: MvfEvent) =>
      `${Math.trunc(e.x / SQUARE_SIZE) + 1} ${Math.trunc(e.y / SQUARE_SIZE) + 1} (${e.x} ${e.y})`;
    const ts = (e: MvfEvent) => `${e.sec}.${String(e.ths).padStart(3, "0")}`;

    const first = this.video[0];
    if (first) {
      const ev = first.lb ? "lc" : first.rb ? "rc" : first.mb ? "mc" : "mv";
      lines.push(`${ts(first)} ${ev} ${cell(first)}`);
    }
    for (let i = 1; i < this.video.length; i++) {
      const e = this.video[i];
      const prev = this.video[i - 1];
      const evs: string[] = [];
      if (e.x !== prev.x || e.y !== prev.y) evs.push("mv");
      if (e.lb && !prev.lb) evs.push("lc");
      if (e.rb && !prev.rb) evs.push("rc");
      if (e.mb && !prev.mb) evs.push("mc");
      if (!e.lb && prev.lb) evs.push("lr");
      if (!e.rb && prev.rb) evs.push("rr");
      if (!e.mb && prev.mb) evs.push("mr");
      for (const ev of evs) lines.push(`${ts(e)} ${ev} ${cell(e)}`);
    }
    return lines;
  }
}

/** 解析 MVF 文件为 RawVF 文本行；失败抛 MvfParseError，无法识别版本返回 null */
export function mvfToRawvf(buf: Buffer): string[] | null {
  const parser = new MvfParser(buf);
  if (!parser.parse()) return null;
  return parser.toRawvfLines();
}
