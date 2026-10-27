// AVF 生成器：在线玩对局 → Arbiter AVF 字节（2026-10-14；2026-10-26 补齐 FlopPlayer 兼容结构）
// 与 src/lib/avf.ts、ms-toollib/FlopPlayer 两套解析器共同校准：
//   头部 [ver=2][4B junk][mode+2]，雷区 (y+1,x+1) 对；
//   雷区后保留区（长度由盘面计算）+ 国家码，再接 [qm][填充]['['级别'|']；
//   标准级别写 start|end|，自定义级别写 W..H..M..|start|end|；
//   3BV 'B'数字'T'，成绩 (秒+1)'.'两位百分秒']'（解析时再减 1 还原）；
//   事件 8 字节组 [mouse, xHi, secLo, xLo, hun, yHi, secHi, yLo]（解码见 avf.ts）；
//   结束标记 8 个 0（解码 sec=-1 < 0 终止），'cs='+17B（\r 结尾）；
//   Skin:name 对 + 玩家名行（\r 结尾）+ 程序名（须含 '0' 字节终止——站内解析器读到 0x30 停）。
//
// ⚠️ 此录像仅作个人留存/本地回放，绝不入排行：Program 字段写死 ONLINE_PROGRAM_MARKER，
//    上传路由（/api/video/upload）检测到该标记即拒绝（见 route.ts 的 ONLINE_REJECT）。

/** 程序标识：出现在 AVF Program 字段（首个 '0' 之前），上传校验据此拒绝 */
export const ONLINE_PROGRAM_MARKER = "saolei.wang Online";
/** 玩家标示（user_sig 维度）：在线玩录像统一署名，不占用任何真实玩家签名 */
export const ONLINE_PLAYER_NAME = "saolei.online";

/** 单条对局事件（引擎记录；mouse 码与 avf 解析器约定一致） */
export interface OnlineEvent {
  /** 鼠标码：1=mv 3=lc 5=lr 9=rc 17=rr 11=sc 65=mr（自动双击） */
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
  /** 胜局导出时修复无猜重排造成的静态盘回放分叉 */
  won: boolean;
  events: OnlineEvent[];
  /** 结算墙钟时间，Arbiter 完整格式 D.M.YYYY.HH:MM:SS:mmmm；起始时间由成绩反推 */
  timestamp: string;
}

function asciiBytes(s: string): number[] {
  return Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
}

/** ms-toollib 在雷区后按「盘面校验值十进制位数 + 4」跳过保留区，再读 1B 国家码。
 *  保留区内容不参与播放解析，但必须占足字节；国家码 8 = CN。 */
function boardTrailer(w: number, h: number, board: Uint8Array | number[]): number[] {
  const cells = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!board[i]) continue;
      cells[i] = -1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (cells[j] >= 0) cells[j]++;
        }
      }
    }
  }
  let checksum = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const cell = cells[y * w + x];
      checksum += (cell < 0 ? 10 : cell + 1) * (x + x * y);
    }
  }
  return [...new Array(String(checksum).length + 4).fill(0), 8];
}

const AVF_TIMESTAMP = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.(\d{1,2}):(\d{1,2}):(\d{1,2}):(\d{4})$/;

/** Arbiter 同时保存开始、结束两个墙钟时间；结束时间省略月年，跨月由解析器按日号处理。 */
function avfTimestamps(endText: string, scoreCsec: number): { start: string; end: string } {
  const match = AVF_TIMESTAMP.exec(endText);
  if (!match) throw new Error("Invalid AVF timestamp");
  const [, day, month, year, hour, minute, second, fraction] = match;
  const endDate = new Date(+year, +month - 1, +day, +hour, +minute, +second, +fraction);
  if (Number.isNaN(endDate.getTime())) throw new Error("Invalid AVF timestamp");
  const startDate = new Date(endDate.getTime() - scoreCsec * 10);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const time = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}:${String(d.getMilliseconds()).padStart(4, "0")}`;
  return {
    start: `${startDate.getDate()}.${startDate.getMonth() + 1}.${startDate.getFullYear()}.${time(startDate)}`,
    end: `${endDate.getDate()}.${time(endDate)}`,
  };
}

/** 把站内双击手势统一成 mr：双键 chord、sc+lr 与自动双击在外部播放器里同义。
 *  同时移除手势的原始按下/松开，避免归一后残留按键状态污染后续插旗。
 *  ⚠️ 2026-10-27 修（347849 案）：右键先按手势（rc 插旗→按住右键点左键→lr=chord）
 *  里 rc 是**按下即刻生效的真实插旗**（服务端/引擎语义），折叠成 mr 时只可删
 *  待定的 lc，rc 必须保留——否则丢旗：服务端靠它判 WIN，导出流却没这面旗，
 *  回放里 chord 全哑、终局靠 repairWinningEvents 合成点击补洞（347849 6.46s
 *  一瞬间开出一片的怪象）。同理 rr 分支：rc 保留后 rr 也要配对保留，否则
 *  rp 状态残留污染下一手势（rc 在 flop 语义里 rp=true 会吞后续真插旗）。 */
export function canonicalizeOnlineEvents(events: OnlineEvent[]): OnlineEvent[] {
  const out: (OnlineEvent | null)[] = [];
  let lp = false, rp = false, sv = false;
  let lcAt = -1, rcAt = -1;
  const removePresses = () => {
    if (lcAt >= 0) out[lcAt] = null;
    lcAt = -1;
  };
  for (const e of events) {
    if (e.mouse === 3) {
      lp = true;
      if (!rp) { lcAt = out.length; out.push(e); }
    } else if (e.mouse === 9) {
      rp = true;
      if (!lp) { rcAt = out.length; out.push(e); }
    } else if (e.mouse === 11) {
      lp = sv = true; // 随后的 lr 统一收成 mr
    } else if (e.mouse === 5) {
      if (rp || sv) {
        removePresses(); // 只删待定的 lc；rc 是已生效插旗，保留
        out.push({ ...e, mouse: 65 });
        // flop：另一键仍按住，后续可连续 chord；其闭合松开已被抑制。
        // 右键按住场景：rc 已在流中，rp 保持 true 直到 rr 配对闭合（见 mouse===17）
      } else {
        if (lcAt >= 0) out.push(e);
        lcAt = -1;
      }
      lp = sv = false;
    } else if (e.mouse === 17) {
      if (lp) {
        removePresses(); // 左键按住时 rr=chord：同理只删待定 lc；rc（若有）保留
        out.push({ ...e, mouse: 65 });
        lcAt = -1;
      } else {
        if (rcAt >= 0) out.push(e);
        rcAt = -1;
      }
      rp = false;
    } else {
      out.push(e);
    }
  }
  return out.filter((e): e is OnlineEvent => e !== null);
}

/** AVF 只有一张静态雷区；无猜在 chord 展开中重排时，原手势不一定能在终盘上重放。
 *  正常事件原样保留；危险 chord 改为逐格安全点击，末尾补开遗留非雷格，保证胜局可播完。 */
export function repairWinningEvents(
  w: number, h: number, board: Uint8Array | number[], questionMarks: boolean,
  events: OnlineEvent[], scoreCsec: number,
): OnlineEvent[] {
  const n = w * h;
  const nums = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    if (board[i]) { nums[i] = -1; continue; }
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && board[ny * w + nx]) nums[i]++;
    }
  }
  const state = new Uint8Array(n); // 0 未开 / 1 已开 / 2 旗 / 3 问号
  const around = (i: number): number[] => {
    const cells: number[] = [], x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) cells.push(ny * w + nx);
    }
    return cells;
  };
  const openSafe = (i: number) => {
    if (i < 0 || i >= n || state[i] !== 0 || board[i]) return;
    state[i] = 1;
    if (nums[i] === 0) for (const a of around(i)) openSafe(a);
  };
  const flagsAround = (i: number) => around(i).filter((a) => state[a] === 2).length;
  const chordValid = (i: number) => i >= 0 && i < n && state[i] === 1 && (nums[i] === 0 || nums[i] === flagsAround(i));
  const chordHitsMine = (i: number) => chordValid(i) && around(i).some((a) => state[a] === 0 && board[a]);
  const openAroundSafe = (i: number) => {
    if (!chordValid(i)) return;
    for (const a of around(i)) if (!board[a]) openSafe(a);
  };
  const toggleLabel = (i: number) => {
    if (i < 0 || i >= n || state[i] === 1) return;
    if (state[i] === 0) state[i] = 2;
    else if (state[i] === 2) state[i] = questionMarks ? 3 : 0;
    else state[i] = 0;
  };

  const out: (OnlineEvent | null)[] = [];
  const emit = (mouse: number, i: number, time: { sec: number; hun: number }) => {
    out.push({ mouse, x: (i % w) * 16 + 8, y: ((i / w) | 0) * 16 + 8, sec: time.sec, hun: time.hun });
  };
  const emitSafeClick = (i: number, time: { sec: number; hun: number }) => {
    emit(3, i, time); openSafe(i); emit(5, i, time);
  };
  let lcAt = -1;
  for (const e of events) {
    const x = (e.x / 16) | 0, y = (e.y / 16) | 0, i = y * w + x;
    if (e.mouse === 3) {
      lcAt = out.length; out.push(e);
    } else if (e.mouse === 5) {
      if (lcAt >= 0 && i >= 0 && i < n && state[i] === 0 && board[i]) {
        out[lcAt] = null; // 防御：静态终盘上的直接踩雷事件不导出
      } else {
        out.push(e);
        if (lcAt >= 0) openSafe(i);
      }
      lcAt = -1;
    } else if (e.mouse === 9) {
      out.push(e); toggleLabel(i);
    } else if (e.mouse === 65 && chordHitsMine(i)) {
      for (const a of around(i)) if (state[a] === 0 && !board[a]) emitSafeClick(a, e);
    } else {
      out.push(e);
      if (e.mouse === 65) openAroundSafe(i);
    }
  }

  const end = { sec: (scoreCsec / 100) | 0, hun: scoreCsec % 100 };
  for (let i = 0; i < n; i++) {
    if (board[i] || state[i] === 1) continue;
    while (state[i] !== 0) { emit(9, i, end); toggleLabel(i); emit(17, i, end); }
    emitSafeClick(i, end);
  }
  return out.filter((e): e is OnlineEvent => e !== null);
}

/** 生成标准 AVF 字节流（非 fs 版本格式，与真实 Arbiter 文件同构） */
export function buildOnlineAvf(input: OnlineAvfInput): Uint8Array {
  const { width: w, height: h, mines: m, board, questionMarks: qm, bbbv, scoreCsec, won, events, timestamp } = input;
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

  out.push(...boardTrailer(w, h, board));

  // FlopPlayer 只认 [级别|；站内解析器同样吞掉该 '|'。qm 须位于 '[' 前两字节。
  out.push(qm ? 17 : 127, 0, 0x5b, 47 + mode, 0x7c);
  const ts = avfTimestamps(timestamp, scoreCsec);
  if (mode === 4) out.push(...asciiBytes(`W${w}H${h}M${m}|`));
  out.push(...asciiBytes(ts.start), 0x7c, ...asciiBytes(ts.end), 0x7c);

  out.push(0x42, ...asciiBytes(String(bbbv)), 0x54); // 'B' 3BV 'T'
  const sec = Math.floor(scoreCsec / 100), csec = scoreCsec % 100;
  out.push(...asciiBytes(String(sec + 1)), 0x2e, ...asciiBytes(String(csec).padStart(2, "0")), 0x5d);

  const writeEvent = (e: OnlineEvent, mouse: number) => {
    const raw = e.sec + 1; // 编码 +1，解码 -1（AVF 惯例）
    out.push(mouse, (e.x >> 8) & 0xff, raw & 0xff, e.x & 0xff, e.hun, (e.y >> 8) & 0xff, (raw >> 8) & 0xff, e.y & 0xff);
  };
  const canonical = canonicalizeOnlineEvents(events);
  const exportEvents = won ? repairWinningEvents(w, h, board, qm, canonical, scoreCsec) : canonical;
  for (let i = 0; i < exportEvents.length; i++) {
    const e = exportEvents[i];
    /* 站内用 sc+lr 表示「单击已开数字」，用孤立 mr 表示自动双击；AVF/FlopPlayer
       的标准中键序列是 mc+mr。统一导出为完整配对，同时规避 ms-toollib 的 sc panic。 */
    const mouse = e.mouse === 11 ? 65 : e.mouse;
    if (mouse === 65) writeEvent(e, 33);
    writeEvent(e, mouse);
    const next = exportEvents[i + 1];
    if (e.mouse === 11 && next?.mouse === 5 && next.sec === e.sec && next.hun === e.hun && next.x === e.x && next.y === e.y) i++;
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
  /** 扩展名（2026-10-26 张老师定：练习页下载统一 EVF，替代原 AVF） */
  ext?: "avf" | "evf";
}): string {
  const { level, csec, nf, bbbv, user, date = new Date(), ext = "avf" } = input;
  const lv = level[0].toUpperCase() + level.slice(1);
  /* 用时口径与 lib/format 的 scoreTime 一致：毫秒 ÷ 1000 → 两位小数 */
  const secs = (csec / 100).toFixed(2);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
  return (
    `${lv} ${secs}s${nf ? " NF" : ""} - 3BV ${bbbv}` +
    (user ? ` - # ${user.id} ${user.name}` : "") +
    ` (${day}).${ext}`
  );
}
