// AVF 解析器：忠实移植 vendors/RawVF/avf_parser.c（349 行 C，avf2rawvf 0.4）
// 输入 AVF 二进制，输出 RawVF 文本行（再经 rawvf.ts 的 formatRawvf 结构化）
// 与 C 版的唯一刻意差异：玩家名在输出前已从 gb2312 解码为 utf-8

const MAXNAME = 1000;

export class AvfParseError extends Error {}

interface AvfEvent {
  sec: number;
  hun: number; // 百分之一秒
  ths: number; // 毫秒个位（仅 fs 版本）
  x: number;
  y: number;
  mouse: number;
}

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  u8(): number {
    if (this.pos >= this.buf.length) throw new AvfParseError("Unexpected end of file");
    return this.buf[this.pos++];
  }
  get length() {
    return this.buf.length;
  }
}

/** gb2312 玩家名解码（同 mvf.ts） */
const gbkDecoder = new TextDecoder("gb18030");
function decodeName(bytes: number[]): string {
  return gbkDecoder.decode(new Uint8Array(bytes));
}

class AvfParser {
  private r: Reader;
  private ver = 0;
  private fs = false;
  private l = 0;
  private ll = 0;
  private ls = 0;
  private mode = 0;
  private w = 0;
  private h = 0;
  private m = 0;
  private board: number[] = [];
  private qm = false;
  private bbbv = 0;
  private scoreSec = 0;
  private scoreThs = 0;
  private name = "";
  private skin = "";
  private program = "";
  private timestamp = "";
  private video: AvfEvent[] = [];

  constructor(buf: Buffer) {
    this.r = new Reader(buf);
  }

  /** getpair：读 "key:value\r" 对，返回 [name, value, hasValue]
   *  C 版以 c2[0]=='\0' 判空——只有当 key 行以 '\r' 结束（无冒号的名字行）才为空；
   *  "Key:\r" 这种 value 仅含 '\r' 的情况在 C 里算非空，必须保持 */
  private getpair(): [string, string, boolean] {
    const r = this.r;
    const c1: number[] = [];
    let c = 0;
    while (c !== 0x3a && c !== 13 && c1.length < MAXNAME) {
      // 0x3a = ':'
      c = r.u8();
      if (c === 0x3c) {
        // '<'：arb 的 name<mouse>mouse 模式，整行作废（C 返回两个空串）
        while (r.u8() !== 13);
        return ["", "", false];
      }
      c1.push(c);
    }
    c1.pop(); // 丢掉结尾的 ':' 或 '\r'
    const endedOnCR = c === 13;
    const c2: number[] = [];
    while (!endedOnCR && c !== 13 && c2.length < MAXNAME) {
      c = r.u8();
      c2.push(c);
    }
    const hasValue = c2.length > 0; // C 的 value[0]!=0
    if (c2.length && c2[c2.length - 1] === 13) c2.pop();
    return [decodeName(c1), decodeName(c2), hasValue];
  }

  parse(): boolean {
    const r = this.r;

    // 版本与标志位
    let c = r.u8();
    this.ver = c;
    this.fs = c === 0;
    if (!this.fs) {
      for (let i = 0; i < 4; i++) r.u8(); // 无意义字节
    } else {
      this.ver = r.u8();
      c = r.u8();
      this.l = c & 0x1;
      this.ll = c & 0x8;
      this.ls = c & 0x10;
      r.u8();
      r.u8();
    }

    // 模式与棋盘尺寸
    c = r.u8();
    this.mode = c - 2;
    if (this.mode === 1) {
      this.w = this.h = 8;
      this.m = 10;
    } else if (this.mode === 2) {
      this.w = this.h = 16;
      this.m = 40;
    } else if (this.mode === 3) {
      this.w = 30;
      this.h = 16;
      this.m = 99;
    } else if (this.mode === 4) {
      this.w = r.u8() + 1;
      this.h = r.u8() + 1;
      this.m = r.u8() * 256 + r.u8();
    } else {
      return false;
    }

    // 雷位（1 起始坐标，c 为行 d 为列）
    this.board = new Array(this.w * this.h).fill(0);
    for (let i = 0; i < this.m; i++) {
      const y = r.u8() - 1;
      const x = r.u8() - 1;
      this.board[y * this.w + x] = 1;
    }

    // 找时间戳：[ 后跟 '0'+(mode-1)，前两字节须为 17(开问号) 或 127
    const cr = [0, 0, 0, 0];
    for (;;) {
      while (cr[3] !== 0x5b) {
        // '['
        cr[0] = cr[1];
        cr[1] = cr[2];
        cr[2] = cr[3];
        cr[3] = r.u8();
      }
      cr[0] = cr[1];
      cr[1] = cr[2];
      cr[2] = cr[3];
      cr[3] = r.u8();
      if (cr[3] - 47 === this.mode) break;
    }
    if (cr[0] !== 17 && cr[0] !== 127) return false;
    this.qm = cr[0] === 17;
    r.u8();
    const tsBytes: number[] = [];
    for (;;) {
      const b = r.u8();
      if (b === 0x7c) break; // '|'
      tsBytes.push(b);
      if (tsBytes.length >= MAXNAME) break;
    }
    this.timestamp = decodeName(tsBytes);

    // 3BV：'B' 后数字直到 'T'
    while (r.u8() !== 0x42); // 'B'
    let digits: number[] = [];
    for (;;) {
      c = r.u8();
      if (c === 0x54 || c === 0) break; // 'T'
      digits.push(c);
    }
    this.bbbv = parseInt(decodeName(digits), 10) || 0;

    // 成绩：sec '.' ths ']'（real time = time - 1）
    digits = [];
    for (;;) {
      c = r.u8();
      if (c === 0x2e || c === 0) break; // '.'
      digits.push(c);
    }
    this.scoreSec = (parseInt(decodeName(digits), 10) || 0) - 1;
    digits = [];
    for (;;) {
      c = r.u8();
      if (c === 0x5d || c === 0) break; // ']'
      digits.push(c);
    }
    this.scoreThs = parseInt(decodeName(digits), 10) || 0;

    // 事件起点：滑动窗口找 cr[2]==1 且 cr[1]<=1
    const ev = [0, 0, 0, 0, 0, 0, 0, 0];
    while (ev[2] !== 1 || ev[1] > 1) {
      ev[0] = ev[1];
      ev[1] = ev[2];
      ev[2] = r.u8();
    }
    for (let i = 3; i < 8; i++) ev[i] = r.u8();

    // 事件流：sec<0 为结束标记
    for (;;) {
      const e: AvfEvent = {
        mouse: ev[0],
        x: ev[1] * 256 + ev[3],
        y: ev[5] * 256 + ev[7],
        sec: ev[6] * 256 + ev[2] - 1,
        hun: ev[4],
        ths: 0,
      };
      if (e.sec < 0) break;
      this.video.push(e);
      for (let i = 0; i < 8; i++) ev[i] = r.u8();
    }

    // 玩家名：先找 'cs='，fs 版本还要先读每事件的毫秒个位
    const tag = [0, 0, 0];
    while (!(tag[0] === 0x63 && tag[1] === 0x73 && tag[2] === 0x3d)) {
      // 'c','s','='
      tag[0] = tag[1];
      tag[1] = tag[2];
      tag[2] = r.u8();
    }
    if (this.fs) {
      for (let i = 0; i < this.video.length; i++) {
        this.video[i].ths = r.u8() & 0xf;
      }
      for (let i = 0; i < 17; i++) r.u8();
      while (r.u8() !== 13);
    } else {
      for (let i = 0; i < 17; i++) r.u8();
    }

    // name:value 对读到 value 为空——此时 name 就是玩家名
    for (;;) {
      const [name, value, hasValue] = this.getpair();
      if (hasValue) {
        if (name === "Skin") this.skin = value;
      } else {
        this.name = name;
        break;
      }
    }

    // 软件名：读到 '0'（或 fs 时读到任意数字）为止
    const prog: number[] = [];
    for (;;) {
      const b = r.u8();
      if (b === 0x30 || (this.fs && b >= 0x30 && b <= 0x39)) break;
      prog.push(b);
      if (prog.length >= MAXNAME) break;
    }
    this.program = decodeName(prog);

    return true;
  }

  /** writetxt：输出 RawVF 文本行（与 C 版一致） */
  toRawvfLines(): string[] {
    const levelNames = ["null", "beginner", "intermediate", "expert", "custom"];
    const modeNames = ["null", "classic", "classic", "classic", "density"];
    const p2 = (n: number) => String(n).padStart(2, "0");

    const lines: string[] = [
      "RawVF_Version: Rev5",
      `Program: ${this.program}`,
      this.fs ? `Version: R${this.ver}` : `Version: 0.${this.ver}`,
      `Player: ${this.name}`,
      `Timestamp: ${this.timestamp}`,
      `Level: ${levelNames[this.mode]}`,
      `Width: ${this.w}`,
      `Height: ${this.h}`,
      `Mines: ${this.m}`,
    ];
    if (this.skin) lines.push(`Skin: ${this.skin}`);
    if (!this.l) {
      lines.push(`Mode: ${modeNames[this.mode]}`);
    } else {
      lines.push("Mode: lucky");
      if (this.ll) lines.push("LuckLibrary: on");
      if (this.ls) lines.push("LuckSolver: on");
    }
    lines.push(`Time: ${this.scoreSec}.${p2(this.scoreThs)}`);
    lines.push(`3BV: ${this.bbbv}`);
    if (this.qm) lines.push("QuestionMarks: on");
    lines.push("Board:");
    for (let y = 0; y < this.h; y++) {
      let row = "";
      for (let x = 0; x < this.w; x++) row += this.board[y * this.w + x] ? "*" : "0";
      lines.push(row);
    }
    lines.push("Events:");

    const mouseName: Record<number, string> = {
      1: "mv", 3: "lc", 5: "lr", 9: "rc", 17: "rr", 33: "mc", 65: "mr",
      145: "rr", 193: "mr", 11: "sc", 21: "lr",
    };
    let curx = -1;
    let cury = -1;
    for (const e of this.video) {
      if (e.mouse === 1 && e.x === curx && e.y === cury) continue;
      curx = e.x;
      cury = e.y;
      const ts = this.fs
        ? `${e.sec}.${p2(e.hun)}${e.ths}`
        : `${e.sec}.${p2(e.hun)}`;
      const ev = mouseName[e.mouse];
      if (!ev) continue;
      lines.push(
        `${ts} ${ev} ${Math.trunc(e.x / 16) + 1} ${Math.trunc(e.y / 16) + 1} (${e.x} ${e.y})`
      );
    }
    return lines;
  }
}

/** 解析 AVF 文件为 RawVF 文本行；无法识别返回 null，损坏抛 AvfParseError */
export function avfToRawvf(buf: Buffer): string[] | null {
  const parser = new AvfParser(buf);
  if (!parser.parse()) return null;
  return parser.toRawvfLines();
}
