// 本站 EVF v0.3 生成器：排名模式「上传录像」（服务端调用）与练习页「下载录像」
// （客户端调用，2026-10-26 张老师定统一 EVF 下载）共用。
// 使用绝对毫秒时间戳 + 绝对像素坐标的鼠标事件流，复用 lib/evf.ts 解析器与全站 RawVF 管线；
// 事件流须先过 avfwrite 的 canonicalizeOnlineEvents / repairWinningEvents（won 时），
// 否则 ms-toollib（FlopPlayer）重放终盘雷格数 ≠ 雷数，报「不能播放没有扫完的录像」。

import type { OnlineEvent } from "./avfwrite";

export const RANKED_SOFTWARE = "Saolei.wang";

export interface RankedEvfInput {
  width: number;
  height: number;
  mines: number;
  board: Uint8Array | number[];
  questionMarks: boolean;
  nf: boolean;
  bbbv: number;
  scoreCsec: number;
  events: OnlineEvent[];
  /** 玩家标识：排名上传＝`#ID 中文姓名`；练习页下载可省略（未登录等） */
  player?: string;
  /** 唯一标识：排名上传由服务端 randomUUID；练习页下载可省略 */
  uniqueIdentifier?: string;
  /** 是否胜局（仅影响 summary 位 completed；2026-10-26 张老师定：下载也写实况） */
  won?: boolean;
  /** 对局时间（AVF 时间戳串，练习页下载携带；仅作日后扩展，v0.3 头不落此字段） */
  timestamp?: string;
}

export function buildRankedEvf(input: RankedEvfInput): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => out.push((v >>> 8) & 0xff, v & 0xff);
  const u24 = (v: number) => out.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const cstr = (s: string) => {
    out.push(...new TextEncoder().encode(s), 0);
  };

  u8(3); // EVF v0.3
  /* summary：completed 按实况（败局下载不标 completed，与站内胜负判定一致）；
     official + fair 恒置（本站生成即官方公平局）；NF 按模式。 */
  u8((input.won === false ? 0x00 : 0x80) | 0x60 | (input.nf ? 0x10 : 0));
  u8(input.questionMarks ? 0x80 : 0); // v0.3 设置位：问号开关
  u8(input.height);
  u8(input.width);
  u16(input.mines);
  u8(16); // 全站统一 16px 格子坐标
  u16(0); // classic
  u16(input.bbbv);
  u24(input.scoreCsec * 10);
  cstr(RANKED_SOFTWARE);
  cstr(input.player ?? "");
  cstr(""); // race identifier
  cstr(input.uniqueIdentifier ?? "");
  cstr(""); // v0.1-v0.3 legacy start timestamp（本软件不用该字段）
  cstr(""); // legacy end timestamp
  cstr(""); // country
  cstr(""); // v0.2+ device UUID

  // 雷区位图 MSB-first；每字节未使用的末位补 0。
  for (let bit = 0; bit < input.width * input.height; bit += 8) {
    let value = 0;
    for (let j = 0; j < 8 && bit + j < input.width * input.height; j++) {
      if (input.board[bit + j]) value |= 1 << (7 - j);
    }
    u8(value);
  }

  const mouseCode = (mouse: number): number | null => {
    // Online/AVF → EVF：mv/lc/lr/rc/rr/mc/mr 映射；sc → cc；mr（自动双击）→ mr。
    const map: Record<number, number> = { 1: 1, 3: 2, 5: 3, 9: 4, 17: 5, 33: 6, 65: 7, 11: 9 };
    return map[mouse] ?? null;
  };
  for (const e of input.events) {
    const code = mouseCode(e.mouse);
    if (code === null) throw new Error("Unsupported mouse event");
    u8(code);
    u24(e.sec * 1000 + e.hun * 10);
    u16(e.x);
    u16(e.y);
  }
  u8(0); // v0.1-v0.3：有 32 字节校验和段的事件流结束符
  for (let i = 0; i < 32; i++) u8(0); // 本站不使用该校验和，保留全零段
  return new Uint8Array(out);
}
