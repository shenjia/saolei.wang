// AVF 生成器：在线玩对局 → 标准 AVF 字节（2026-10-14）
// 与 src/lib/avf.ts 解析器互为逆操作——已用真实文件字节级比对校准：
//   头部 [ver=2][4B junk][mode+2]，雷区 (y+1,x+1) 对，
//   时间戳标记 [qm字节(17|127)][填充][0x5b '['][47+mode 数字][填充(被解析器吞掉)]，ts 以 '|' 结束，
//   3BV 'B'数字'T'，成绩 (秒+1)'.'两位百分秒']'（解析时再减 1 还原），
//   事件 8 字节组 [mouse, xHi, secLo, xLo, hun, yHi, secHi, yLo]（解码见 avf.ts），
//   结束标记 8 个 0（解码 sec=-1 < 0 终止），'cs='+17B（\r 结尾），
//   Skin:name 对 + 玩家名行（\r 结尾）+ 程序名（须含 '0' 字节终止——解析器读到 0x30 停）。
//
// ⚠️ 此录像仅作个人留存/本地回放，绝不入排行：Program 字段写死 ONLINE_PROGRAM_MARKER，
//    上传路由（/api/video/upload）检测到该标记即拒绝（见 route.ts 的 ONLINE_REJECT）。

/** 程序标识：出现在 AVF Program 字段（首个 '0' 之前），上传校验据此拒绝 */
export const ONLINE_PROGRAM_MARKER = "saolei.wang Online";
/** 玩家标示（user_sig 维度）：在线玩录像统一署名，不占用任何真实玩家签名 */
export const ONLINE_PLAYER_NAME = "saolei.online";

/** 单条对局事件（引擎记录；mouse 码与 avf 解析器约定一致） */
export interface OnlineEvent {
  /** 鼠标码：1=mv 3=lc 5=lr 9=rc 17=rr 11=sc */
  mouse: number;
  /** 像素 x（1-based 格坐标 ×16 + 偏移；回放光标定位用） */
  x: number;
  /** 像素 y */
  y: number;
  /** 整秒 */
  sec: number;
  /** 百分之一秒（0-99） */
  hun: number;
}

export interface OnlineAvfInput {
  width: number;
  height: number;
  mines: number;
  /** 雷区数组（0/1，行优先；长度 = w*h） */
  board: Uint8Array | number[];
  /** 问号标记开启（写 17，否则 127——解析器 qm 位） */
  questionMarks: boolean;
  bbbv: number;
  /** 用时（百分之一秒；写入时 +1s，解析器还原时 -1） */
  scoreCsec: number;
  events: OnlineEvent[];
  /** 对局时间戳（Arbiter 格式字符串） */
  timestamp: string;
}

function asciiBytes(s: string): number[] {
  return Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
}

/** 生成标准 AVF 字节流（非 fs 版本格式，与真实 Arbiter 文件同构） */
export function buildOnlineAvf(input: OnlineAvfInput): Uint8Array {
  const { width: w, height: h, mines: m, board, questionMarks: qm, bbbv, scoreCsec, events, timestamp } = input;
  const out: number[] = [];

  const std: [number, number, number, number][] = [[8, 8, 10, 1], [16, 16, 40, 2], [30, 16, 99, 3]];
  const hit = std.find(([W, H, M]) => W === w && H === h && M === m);
  const mode = hit ? hit[3] : 4;

  out.push(2); // 版本字节（非 fs 格式；解析为 Version: 0.2）
  out.push(0, 1, 0, 0); // 4 无意义字节（真实文件同构）
  out.push(mode + 2);
  if (mode === 4) {
    out.push(w - 1, h - 1, (m >> 8) & 0xff, m & 0xff);
  }
  for (let i = 0; i < w * h; i++) {
    if (!board[i]) continue;
    const y = (i / w) | 0, x = i % w;
    out.push(y + 1, x + 1);
  }

  // 时间戳标记链：cr[0]（'[' 前两字节）须为 17/127；解析器 break 后吞 1 字节再读 ts
  out.push(qm ? 17 : 127, 0, 0x5b, 47 + mode, 0);
  out.push(...asciiBytes(timestamp));
  out.push(0x7c);

  out.push(0x42, ...asciiBytes(String(bbbv)), 0x54); // 'B' 3BV 'T'
  const sec = Math.floor(scoreCsec / 100), csec = scoreCsec % 100;
  out.push(...asciiBytes(String(sec + 1)), 0x2e, ...asciiBytes(String(csec).padStart(2, "0")), 0x5d);

  for (const e of events) {
    const raw = e.sec + 1; // 编码 +1，解码 -1（AVF 惯例）
    out.push(e.mouse, (e.x >> 8) & 0xff, raw & 0xff, e.x & 0xff, e.hun, (e.y >> 8) & 0xff, (raw >> 8) & 0xff, e.y & 0xff);
  }
  out.push(0, 0, 0, 0, 0, 0, 0, 0); // 结束标记：解码 sec = -1
  out.push(0, 0, 0, 0, 0, 0, 0, 0); // 填充（真实文件同构）

  out.push(...asciiBytes("cs="));
  out.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13); // 17B，\r 结尾
  out.push(...asciiBytes("Skin: 1.0\r"));
  out.push(...asciiBytes(ONLINE_PLAYER_NAME + "\r"));
  // 程序名须含 '0'（0x30）终止字节：解析器 non-fs 分支读到 0x30 停
  out.push(...asciiBytes(ONLINE_PROGRAM_MARKER + "0"));

  return new Uint8Array(out);
}

/** 生成下载文件名——与录像页 /video/download/[id]（VideoModel::getFilename）**同款规则**：
 *    {级别} {秒}.{两位百分秒}s[ NF] - 3BV {3BV}[ - # {用户id} {英文名}] ({YYYY-MM-DD}).avf
 *  例：Exp 12.34s NF - 3BV 123 - # 456 ZhangSan (2013-01-01).mvf
 *  练习局匿名（未登录）时整段 `- # 用户id 英文名` 省略，其余段位逐字对齐录像页。
 *  ⚠️ 级别名走 level[0].toUpperCase() + slice(1)（beg→Beg），与录像页同式；
 *     cus（自定义）无对应录像级别，照样输出 Cus。 */
export function onlineAvfFilename(input: {
  level: string;
  /** 对局用时（百分之一秒）——与 snapshot.csec 同量纲 */
  csec: number;
  nf: boolean;
  bbbv: number;
  /** 登录玩家（未登录传 null/省略）；下载文件名里的署名段 */
  user?: { id: number; name: string } | null;
  /** 文件名里的日期，默认当下（本地时区） */
  date?: Date;
}): string {
  const { level, csec, nf, bbbv, user, date = new Date() } = input;
  const lv = level[0].toUpperCase() + level.slice(1);
  /* 用时口径与 lib/format 的 scoreTime 一致：毫秒 ÷ 1000 → 两位小数 */
  const secs = (csec / 100).toFixed(2);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
  return (
    `${lv} ${secs}s${nf ? " NF" : ""} - 3BV ${bbbv}` +
    (user ? ` - # ${user.id} ${user.name}` : "") +
    ` (${day}).avf`
  );
}
