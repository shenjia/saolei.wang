// 本站 EVF v0.3 生成器：排名模式「上传录像」（服务端调用）与练习页「下载录像」
// （客户端调用，2026-10-26 张老师定统一 EVF 下载）共用。
// 使用绝对毫秒时间戳 + 绝对像素坐标的鼠标事件流，复用 lib/evf.ts 解析器与全站 RawVF 管线；
// 事件流须先过 avfwrite 的 canonicalizeOnlineEvents / repairWinningEvents（won 时），
// 否则 ms-toollib（FlopPlayer）重放终盘雷格数 ≠ 雷数，报「不能播放没有扫完的录像」。

import type { OnlineEvent } from "./avfwrite";

/** 站内排名/练习客户端软件名（evf Software 字段 + DB software 列判等值） */
export const RANKED_SOFTWARE = "Saolei.wang";
/* 客户端代际版本（2026-10-29 张老师二定）：0.3＝点击坐标归一格心（旧版）；
 * 0.4 起＝忠实记录真实点击坐标+格内钳制（af3b40e）；
 * 0.5 起＝事件时间戳 1ms 精度（2026-10-29 张老师定：点击 ms 时间随
 * sendEvent/queueMove 上报权威，EVF 导出直写毫秒——旧厘秒网格截断按压
 * 时长取证，4 次 <20ms 按压在 10ms 网格下无法进一步定界）。
 * ⚠️ 版本号必须由客户端自己上报（上传请求带 clientVersion）——服务端代码没有
 * 版本可言，绝不能按服务端部署代际盖章（2026-10-29 348342 案：旧页签跑旧
 * bundle 格心录制，服务端却盖 0.4，标签与行为脱节）。客户端不报＝0.3（旧版）。 */
export const RANKED_CLIENT_VERSION_DEFAULT = "0.3";
/** 客户端上报版本的白名单校验（防伪造未来版本；服务端只信自己认识的代际） */
export const RANKED_CLIENT_VERSIONS = ["0.3", "0.4", "0.5"] as const;
export type RankedClientVersion = (typeof RANKED_CLIENT_VERSIONS)[number];

/** 校验客户端自报版本：合法返回原值，非法/缺省回退 0.3 */
export function normalizeClientVersion(v: unknown): RankedClientVersion {
  return typeof v === "string" && (RANKED_CLIENT_VERSIONS as readonly string[]).includes(v)
    ? (v as RankedClientVersion)
    : RANKED_CLIENT_VERSION_DEFAULT;
}

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
  /** 对局用时毫秒（2026-10-30 张老师定：＝事件流末端毫秒，与 flop 播放器显示完全一致）。
   *  优先于 scoreCsec*10 写入 EVF 头 rtime；不传退回旧口径。 */
  scoreMs?: number;
  /** 对局时间（AVF 时间戳串，练习页下载携带；仅作日后扩展，v0.3 头不落此字段） */
  timestamp?: string;
  /** 客户端代际版本（2026-10-29 张老师二定：版本号随客户端代码走，不随服务端走）。
   *  排名上传＝服务端从请求体 clientVersion 字段取（白名单校验后传入）；
   *  练习页下载＝客户端自己传常量（OnlinePlay 内联）；
   *  凭据 evf（cheat report）＝服务端生成，无客户端版本语义，缺省 0.3 */
  clientVersion?: string;
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
  /* 头部 rtime（ms）：2026-10-30 起＝事件流末端毫秒（scoreMs 优先）；
     旧口径 scoreCsec*10 仍支持（作弊凭据/未适配调用方） */
  u24(input.scoreMs ?? input.scoreCsec * 10);
  cstr(`${RANKED_SOFTWARE} ${input.clientVersion ?? RANKED_CLIENT_VERSION_DEFAULT}`);
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
  /* ⚠️ 时间单调钳制（2026-10-27，347943 案）：排名流里点击走 sendEvent 即时上报、
     mv 走 queueMove 攒批，服务端权威流中攒批 mv 带按下前的旧时间戳 → 事件流
     出现「1.110 lr → 1.090 mv」式倒退。站内回放引擎按时间分发不怕倒序，flop
     官方 VideoParser 强制时间单调，直接抛 VideoParserError – Unexpected time
     flow，后台 flop 播放报错。导出时钳制为不减（最多前移 20ms，肉眼不可察）。 */
  let lastMs = 0;
  for (const e of input.events) {
    const code = mouseCode(e.mouse);
    if (code === null) throw new Error("Unsupported mouse event");
    u8(code);
    /* 事件时间：ms 字段优先（0.5 代客户端/权威流，1ms 精度）；
       旧数据无 ms 回退 sec/hun 厘秒折算。单调钳制对两种来源同样生效 */
    const ms = Math.max(e.ms ?? e.sec * 1000 + e.hun * 10, lastMs);
    u24(ms);
    lastMs = ms;
    u16(e.x);
    u16(e.y);
  }
  u8(0); // v0.1-v0.3：有 32 字节校验和段的事件流结束符
  for (let i = 0; i < 32; i++) u8(0); // 本站不使用该校验和，保留全零段
  return new Uint8Array(out);
}
