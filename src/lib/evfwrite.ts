// 本站 EVF v4（元 3.2.1+/3.3.x 格式）生成器：排名模式「上传录像」（服务端调用）
// 与练习页「下载录像」（客户端调用，2026-10-26 张老师定统一 EVF 下载）共用。
// 2026-11-05 张老师定：升级 v0.3 → v4——增量时间戳（u8 毫秒 + 停顿事件桥接）
// + 增量坐标（i16）+ uint64 微秒起止时间戳 + u16 长度前缀校验和段（本站写零长）。
// 复用 lib/evf.ts 解析器（v4 分支已就绪）与全站 RawVF 管线；
// 事件流为原始流（2026-11-03 张老师定：不 canonicalize 折叠，mr 折叠会让 flop 键态机
// 失步丢旗）；won 时仍须过 avfwrite 的 repairWinningEvents，否则 ms-toollib（FlopPlayer）
// 重放终盘雷格数 ≠ 雷数，报「不能播放没有扫完的录像」。

import type { OnlineEvent } from "./avfwrite";

/** 站内排名/练习客户端软件名（evf Software 字段 + DB software 列判等值） */
export const RANKED_SOFTWARE = "Saolei.wang";
/* 客户端代际版本（2026-10-29 张老师二定）：0.3＝点击坐标归一格心（旧版）；
 * 0.4 起＝忠实记录真实点击坐标+格内钳制（af3b40e）；
 * 0.5 起＝事件时间戳 1ms 精度（2026-10-29 张老师定：点击 ms 时间随
 * sendEvent/queueMove 上报权威，EVF 导出直写毫秒——旧厘秒网格截断按压
 * 时长取证，4 次 <20ms 按压在 10ms 网格下无法进一步定界）。
 * ⚠️ 代际版本描述的是「录制行为」，与 EVF 容器格式版本（v4）无关：旧页签
 * 跑旧 bundle 录制的流同样由服务端封装成 v4 容器，Software 仍如实自报旧代际。
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
  /** 是否胜局（仅影响 summary 位 completed/official/fair；2026-10-26 张老师定：下载也写实况） */
  won?: boolean;
  /** 对局用时毫秒（2026-10-30 张老师定：＝事件流末端毫秒，与 flop 播放器显示完全一致）。
   *  优先于 scoreCsec*10 写入 EVF 头 rtime；不传退回旧口径。 */
  scoreMs?: number;
  /** 对局时间（AVF 时间戳串「D.M.YYYY.HH:MM:SS:mmmm」，练习页下载携带）。
   *  v4 起仅在未传 endedAtMs 时兜底解析（按本机时区）折算起止时间戳 */
  timestamp?: string;
  /** 对局开始（计时起点）墙钟毫秒（v4 uint64 起始时间戳来源）。
   *  排名上传＝权威 finalize startedAt（首格开出时刻）；不传＝endedAtMs − rtime */
  startedAtMs?: number;
  /** 对局结束墙钟毫秒（v4 uint64 结束时间戳来源）。
   *  排名上传＝权威 overAt（旧权威进程缺失时由路由以 Date.now() 兜底）；
   *  练习页＝结算面板拍摄时刻 Date.now() */
  endedAtMs?: number;
  /** 客户端代际版本（2026-10-29 张老师二定：版本号随客户端代码走，不随服务端走）。
   *  排名上传＝服务端从请求体 clientVersion 字段取（白名单校验后传入）；
   *  练习页下载＝客户端自己传常量（OnlinePlay 内联）；
   *  凭据 evf（cheat report）＝服务端生成，无客户端版本语义，缺省 0.3 */
  clientVersion?: string;
}

/** AVF 时间戳串「D.M.YYYY.HH:MM:SS:mmmm」→ 本机时区 epoch 毫秒；解析失败返回 null */
function parseAvfTimestamp(s: string): number | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.(\d{2}):(\d{2}):(\d{2}):(\d{1,4})$/.exec(s.trim());
  if (!m) return null;
  const [, d, mo, y, h, mi, sec, ms] = m.map(Number) as unknown as number[];
  const t = new Date(y, mo - 1, d, h, mi, sec, ms).getTime();
  return Number.isFinite(t) ? t : null;
}

export function buildRankedEvf(input: RankedEvfInput): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => out.push((v >>> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  /* uint64：时间戳量级 ~1.8e15 微秒 < 2^53，Number 精度安全；BE 高位在前 */
  const u64 = (v: number) => {
    const hi = Math.floor(v / 0x1_0000_0000);
    u32(hi);
    u32(v - hi * 0x1_0000_0000);
  };
  const cstr = (s: string) => {
    out.push(...new TextEncoder().encode(s), 0);
  };

  /* 盘外坐标哨兵化（2026-10-30 修，video 348796 案）：ms-toollib（flop 播放器）
     step() 断言坐标合法形态仅有两种——盘内 (y<行数,x<列数) 或恰好边界点
     (行数,列数)（像素即 (W*16, H*16)），其余任何越界形式直接 panic
     （RuntimeError: unreachable）。旧客户端 recordEvPx 曾把盘外点击记成
     「(格心x, H*16+8)」＝一排外的格心，flop 全数不可播。此处导出端兜底：
     点击类事件（lc/lr/rc/rr/mc/mr/cc）越界时收敛到哨兵点；mv 光标事件
     flop 只渲染不校验（实测 100+ 存量带越界 mv 的文件均正常），原样保留。
     v4 坐标写增量后语义不变：差值按模 65536 折算 i16，解析端重包回同一 u16。 */
  const sentinelX = input.width * 16;
  const sentinelY = input.height * 16;
  const CLICK_MOUSE = new Set([3, 5, 9, 17, 33, 65, 11]);
  for (const e of input.events) {
    if (CLICK_MOUSE.has(e.mouse) && (e.x >= sentinelX || e.y >= sentinelY || e.x < 0 || e.y < 0)) {
      e.x = sentinelX;
      e.y = sentinelY;
    }
  }

  /* —— 事件流预归一：类型映射 + 时间单调钳制，两遍走（增量编码需要上一事件状态）—— */
  const mouseCode = (mouse: number): number | null => {
    // Online/AVF → EVF v4：mv/lc/lr/rc/rr/mc/mr/cc 事件码同值直通（AVF 位掩码恰好对齐 v4 编码）。
    const map: Record<number, number> = { 1: 1, 3: 2, 5: 3, 9: 4, 17: 5, 33: 6, 65: 7, 11: 9 };
    return map[mouse] ?? null;
  };
  /* ⚠️ 时间单调钳制（2026-10-27，347943 案）：排名流里点击走 sendEvent 即时上报、
     mv 走 queueMove 攒批，服务端权威流中攒批 mv 带按下前的旧时间戳 → 事件流
     出现「1.110 lr → 1.090 mv」式倒退。站内回放引擎按时间分发不怕倒序，flop
     官方 VideoParser 强制时间单调，直接抛 VideoParserError – Unexpected time
     flow，后台 flop 播放报错。导出时钳制为不减（最多前移 20ms，肉眼不可察）。 */
  const normEvents: { code: number; ms: number; x: number; y: number }[] = [];
  let clampMs = 0;
  for (const e of input.events) {
    const code = mouseCode(e.mouse);
    if (code === null) throw new Error("Unsupported mouse event");
    /* 事件时间：ms 字段优先（0.5 代客户端/权威流，1ms 精度）；
       旧数据无 ms 回退 sec/hun 厘秒折算。单调钳制对两种来源同样生效 */
    const ms = Math.max(e.ms ?? e.sec * 1000 + e.hun * 10, clampMs);
    clampMs = ms;
    normEvents.push({ code, ms, x: e.x, y: e.y });
  }

  const rtimeMs = Math.max(0, Math.round(input.scoreMs ?? input.scoreCsec * 10));

  /* —— 流首约束（ms-toollib evf_video.rs parse_v4 把首个事件单独解析，实测
     v1.5.20 panic 复盘）：首事件类型只接受 mv/lc/rc/pf，时间增量按 u8 读，
     停顿桥接在首事件之前不生效（读到 255 落入首事件 match 直接 panic）。
     防御性兜底：
     ① 时间轴重锚：首事件原始毫秒 >255 时整体平移回 0（本站事件轴 0 点＝
        计时起点，首事件恒 ≈0ms，正常局不触发；触发时事件轴末端 ≤ rtime，
        flop 显示仍以头部 rtime＝落库成绩为准，不受影响）；
     ② 类型守卫：流首若为 lr/rr/mc/mr/cc（客户端极端丢按下上报），前置一个
        同坐标 mv（对 Rust 解析器是合法流首），回放语义不变。 */
  if (normEvents.length > 0) {
    const firstMs = normEvents[0].ms;
    if (firstMs > 255) for (const e of normEvents) e.ms -= firstMs;
    const firstCode = normEvents[0].code;
    if (firstCode !== 1 && firstCode !== 2 && firstCode !== 4) {
      normEvents.unshift({ code: 1, ms: 0, x: normEvents[0].x, y: normEvents[0].y });
    }
  }

  /* —— 起止时间戳（uint64 微秒）：优先调用方传入的墙钟毫秒；
     缺省按 rtime 对称推算；AVF 时间戳串兜底；全缺＝0（视为未知） —— */
  let endMs = input.endedAtMs;
  if (endMs == null && input.timestamp) endMs = parseAvfTimestamp(input.timestamp) ?? undefined;
  let startMs = input.startedAtMs;
  if (startMs == null && endMs != null) startMs = endMs - rtimeMs;
  else if (endMs == null && startMs != null) endMs = startMs + rtimeMs;

  u8(4); // EVF v0.4
  /* summary：v4 语义下 official/fair 蕴含 completed（「一定扫完」），败局凭据
     （won=false，2026-10-28 cheat report 口径）三位置 0；胜局＝本站标准模式
     （mode=0）排名局，official+fair 恒置。NF 按模式。转码位恒 0（本站直录）。 */
  u8((input.won === false ? 0 : 0xe0) | (input.nf ? 0x10 : 0));
  /* 设置位：问号开关照实；指针越界限制/触雷自动重开本站均未启用，恒 0 */
  u8(input.questionMarks ? 0x80 : 0);
  u8(input.height); // 行数
  u8(input.width); // 列数
  u16(input.mines);
  u8(16); // 全站统一 16px 格子坐标
  u16(0); // standard
  u16(input.bbbv);
  u32(rtimeMs);
  out.push(0x58, 0x58); // country "XX"：ISO 3166-1 无法解析国家的标准占位
  u64(Math.round((startMs ?? 0) * 1000));
  u64(Math.round((endMs ?? 0) * 1000));
  cstr(`${RANKED_SOFTWARE} ${input.clientVersion ?? RANKED_CLIENT_VERSION_DEFAULT}`);
  cstr(input.player ?? "");
  cstr(""); // race identifier
  cstr(input.uniqueIdentifier ?? "");
  u16(0); // 设备 UUID 长度＝0（本站不留设备指纹；唯一性由 uniqueIdentifier/gameId 承担）

  // 雷区位图 MSB-first；每字节未使用的末位补 0。
  for (let bit = 0; bit < input.width * input.height; bit += 8) {
    let value = 0;
    for (let j = 0; j < 8 && bit + j < input.width * input.height; j++) {
      if (input.board[bit + j]) value |= 1 << (7 - j);
    }
    u8(value);
  }

  u16(0); // 自定义指标数量＝0（不产指标事件，键名列表为空）

  // —— 事件流（v4 增量编码）——
  let lastMs = 0;
  let lastX = 0;
  let lastY = 0;
  for (const ev of normEvents) {
    /* 时间增量 uint8（0-255ms）：超长间隔用停顿事件（255，u16 毫秒）桥接——
       解析端把停顿累计进下一事件时间戳，多段可拼任意长度间隔 */
    let gap = ev.ms - lastMs;
    while (gap > 255) {
      const chunk = Math.min(gap, 65535);
      u8(255);
      u16(chunk);
      gap -= chunk;
    }
    u8(ev.code);
    u8(gap);
    /* 坐标增量 i16：按模 65536 折算（负坐标包装域与 v0.3 的 u16 绝对值域一致），
       解析端 (last + i16) & 0xffff 精确还原原值 */
    const dx = (ev.x - lastX) & 0xffff;
    const dy = (ev.y - lastY) & 0xffff;
    u16(dx);
    u16(dy);
    lastMs = ev.ms;
    lastX = ev.x;
    lastY = ev.y;
  }
  u8(0); // 事件流结束符
  u16(0); // 校验码长度＝0（标准未规定校验算法，外部无法验证，留空段）
  return new Uint8Array(out);
}
