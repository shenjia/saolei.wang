/**
 * 排行局「伪直播」rep 落盘与下发（2026-11-27 张老师需求）。
 *
 * 形态：服务端按 gameId 存每局 EVF（含踩雷/重开的未完成局），观众端轮询拿
 * 已封口的局自动连播——伪直播，无进度条、无「回放/上一局」字样。局级 rep
 * 天然消除了实时观战的场外报点作弊，也绕开长连接扇出/时钟同步的成本。
 *
 * 落盘结构（data/live-rep/<uid>/，已 gitignore；⚠️ 必须放在 public 之外——
 * pending 是进行中局的完整快照（含全部雷位），public 下会被静态直下、
 * 破坏「局级 rep 消除报点作弊」的设计前提；下发一律走 /api/live/rep 粉丝闸）：
 *   state.json              { gameId, lastAt, level } 当前活跃局（心跳保活）
 *   pending/<gameId>.evf    本局最新快照（每次心跳原子覆盖，绝不对客户端下发）
 *   reps/<gameId>.evf       已封口局（观众经 /api/live/rep 鉴权拉取）
 *   index.json              { uid, reps: [...] } 已封口局队列（≤20 条 / 24h）
 *
 * 封口时机：换局（重开/切级别/新局）、局终 final 心跳、观众轮询发现的超时局。
 * 封口优先用 pending 文件——即便权威已清内存（30min TTL）或败局没落盘，
 * 最后 3 秒的快照仍在，重开/断线的局不会丢。
 *
 * 安全：gameId 硬校验（路径穿越防护）；EVF 只供观看，绝不入 video 表、
 * 绝不参与排行判定；观看权由 feed 路由的粉丝闸+黑名单控制，本模块不鉴权。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildRankedEvf } from "./evfwrite";
import { parseEvf } from "./evf";
import { prisma } from "./db";
import { authorityAuthHeaders, authorityBaseFor } from "@/core/src/lib/authority-endpoint";
import { BOARD_SIZE, type VideoLevel } from "./config";

const ROOT = path.join(process.cwd(), "data", "live-rep");
const KEEP_COUNT = 20;
const KEEP_MS = 24 * 60 * 60 * 1000;
/** state 超过此时时长未心跳＝主播已断线，观众轮询时触发封口（3s 心跳 × 4 倍余量） */
export const LIVE_STALE_MS = 12_000;

/* ---- 观众计数（2026-11-27 14:12 张老师需求）----
 * feed 路由每次被粉丝拉取时上报（feedViewerTouch）；心跳响应带回
 * viewers（练习页「自定义」tab 变「x人旁观」）。内存单例（dev 单进程
 * 足够，不落盘）：key＝`<主播uid>:<观众uid>` → 最近活跃时刻，
 * 超过 VIEWER_TTL_MS 的对子视为离场；viewerCount 按主播聚合去重。
 * ⚠️ 单例必须挂 globalThis（2026-11-27 15:15 实证）：Turbopack dev 下
 * page bundle 与 API route bundle 各自实例化本模块，模块级变量不互通
 * （feed touch 写入、user page SSR 读到 0）——globalThis 强制跨 bundle
 * 共享同一 Map。 */
const VIEWER_TTL_MS = 15_000;
type LiveViewerGlobal = { __liveViewers?: Map<string, number>; __liveViewersSweep?: number };
const viewerG = globalThis as typeof globalThis & LiveViewerGlobal;
const viewerLastSeen: Map<string, number> =
  viewerG.__liveViewers ?? (viewerG.__liveViewers = new Map<string, number>());
const lastSweepBox = { get: () => viewerG.__liveViewersSweep ?? 0, set: (v: number) => { viewerG.__liveViewersSweep = v; } };

/** 观众拉 feed 时记录在场（feed 路由调用；主播本人不算观众） */
export function feedViewerTouch(streamerUid: number, viewerUid: number): void {
  viewerLastSeen.set(`${streamerUid}:${viewerUid}`, Date.now());
  /* 惰性清理：整表 15s 扫一次，过期对子离场 */
  const now = Date.now();
  if (now - lastSweepBox.get() < VIEWER_TTL_MS) return;
  lastSweepBox.set(now);
  for (const [key, t] of viewerLastSeen) {
    if (now - t <= VIEWER_TTL_MS) continue;
    viewerLastSeen.delete(key);
  }
}

/** 当前观众数（主播侧：心跳响应带回）——按主播聚合最近活跃的独立观众 */
export function viewerCount(streamerUid: number): number {
  const prefix = `${streamerUid}:`;
  const now = Date.now();
  let n = 0;
  for (const [key, t] of viewerLastSeen) {
    if (key.startsWith(prefix) && now - t <= VIEWER_TTL_MS) n++;
  }
  return n;
}

/** 与权威 isSafeGameId 同口径：<slot>-<uuid> / <region>-<slot>-<uuid> */
function isSafeGameId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 8 && id.length <= 80
    && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

export interface LiveRepState {
  gameId: string;
  lastAt: number;
  level: VideoLevel;
  /** 允许旁观（2026-11-27 张老师定，主播开关，缺省 true）：false＝主播关掉了
   * 旁观（或旧 state 无此字段默认允许） */
  allow?: boolean;
  /** 当前局胜负（2026-11-27 18:54 张老师定：观众端优先放已完成局）——
   *  取自最近一次成功快照的 won；取数失败缺省 undefined（封口按未完成算） */
  won?: boolean;
  /** 当前局完成百分比（2026-11-27 19:21 张老师定）：已开安全格 ÷ 总安全格，
   *  0-100 整数；权威快照自带格态数组，无额外开销。取数失败缺省 undefined */
  progress?: number;
  /** 当前局时长毫秒（2026-11-27 19:31 张老师定：服务端选局「时长最长」
   *  的依据）——快照 scoreMs（事件流末端）；取数失败缺省 undefined */
  scoreMs?: number;
  /** 比赛模式（2026-11-27 20:30 张老师定）：本局属于比赛时存比赛 id + 全称
   *  （心跳从练习页 comp 参数带上；非比赛局心跳不带字段自动清空）——
   *  观众端提醒/主页标记/旁观页「正在参加xxx」显示用 */
  compId?: number;
  compName?: string;
  /** 比赛倒计时终点（Unix 秒，2026-11-27 21:25 张老师定：旁观页比赛名后
   *  剩余时间括号显示）——窗口赛=个人窗口结束、集体赛=比赛结束（练习页
   *  comp.end 原值透传） */
  compEnd?: number;
}

export interface LiveRepMeta {
  gameId: string;
  level: VideoLevel;
  w: number;
  h: number;
  bbbv: number;
  scoreMs: number;
  won: boolean;
  at: number;
}

export interface LiveRepIndex {
  uid: number;
  reps: LiveRepMeta[];
}

const uidDir = (uid: number) => path.join(ROOT, String(uid));
const stateFile = (uid: number) => path.join(uidDir(uid), "state.json");
const indexFile = (uid: number) => path.join(uidDir(uid), "index.json");
const pendingFile = (uid: number, gameId: string) => path.join(uidDir(uid), "pending", `${gameId}.evf`);
const repFile = (uid: number, gameId: string) => path.join(uidDir(uid), "reps", `${gameId}.evf`);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function atomicWrite(file: string, data: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function getState(uid: number): LiveRepState | null {
  const s = readJson<LiveRepState>(stateFile(uid));
  return s && isSafeGameId(s.gameId) && typeof s.lastAt === "number" ? s : null;
}

export function getIndex(uid: number): LiveRepIndex {
  const idx = readJson<LiveRepIndex>(indexFile(uid));
  return idx && Array.isArray(idx.reps) ? idx : { uid, reps: [] };
}

/** 主播是否「正在直播」：有活跃 state 且心跳在 LIVE_STALE_MS 内且未关旁观 */
export function isLiveNow(uid: number): boolean {
  const s = getState(uid);
  return !!s && Date.now() - s.lastAt < LIVE_STALE_MS && s.allow !== false;
}

/** 玩家名缓存（2026-11-27 20:11 张老师定：EVF 玩家标识与排行模式一致「#id 玩家名」，
 *  不再是「#8x8」尺寸）——主键查询虽轻，但心跳 3s 一次，加 5min TTL 缓存免无谓打表；
 *  改名最长 5min 后反映进新局 EVF（观看标识非敏感场景可接受）。 */
const nameCache = new Map<number, { name: string; at: number }>();
async function playerLabel(uid: number): Promise<string> {
  const c = nameCache.get(uid);
  if (c && Date.now() - c.at < 300_000) return c.name;
  let name = "";
  try {
    const u = await prisma.user.findUnique({ where: { id: BigInt(uid) }, select: { chineseName: true } });
    name = u?.chineseName ?? "";
  } catch { /* 查库失败：留空名，snapshotToEvf 兜底旧尺寸标识 */ }
  nameCache.set(uid, { name, at: Date.now() });
  return name;
}

/** 权威快照 → EVF。快照字段口径与 report 路由的反作弊凭据同源。
 *  player 标识（2026-11-27 20:11 张老师定）：与排行模式同口径「#uid 玩家名」；
 *  查不到名（刚注册即开播等极端情况）兜底旧「#宽x高」尺寸标识。 */
function snapshotToEvf(g: {
  width: number; height: number; mines: number; board: number[];
  bbbv: number; scoreCsec: number; scoreMs?: number;
  nf: boolean; questionMarks: boolean;
  startedAt?: number; overAt?: number; won?: boolean;
  events: { mouse: number; x: number; y: number; sec: number; hun: number; ms?: number }[];
}, label: string): Uint8Array {
  return buildRankedEvf({
    width: g.width,
    height: g.height,
    mines: g.mines,
    board: Uint8Array.from(g.board),
    questionMarks: g.questionMarks,
    nf: g.nf,
    bbbv: g.bbbv,
    scoreCsec: g.scoreCsec,
    scoreMs: g.scoreMs,
    won: false, // 观看用途恒按未完成局导出；胜负只进 meta 供展示，不参与排行
    events: g.events,
    player: label || `#${g.width}x${g.height}`,
    startedAtMs: g.startedAt && g.startedAt > 0 ? g.startedAt : undefined,
    endedAtMs: g.overAt && g.overAt > 0 ? g.overAt : undefined,
  });
}

export interface HeartbeatResult {
  ok: boolean;
  error?: string;
  sealed?: string[];
}

/* 比赛全称缓存（2026-11-27 20:30 张老师定）：比赛名不可变，命中即永缓存；
 * 查库失败不缓存（下个心跳重试）。心跳 3s 一次不能每次打表 */
const compNameCache = new Map<number, string>();
async function compNameOf(compId: number): Promise<string | undefined> {
  const hit = compNameCache.get(compId);
  if (hit) return hit;
  try {
    const t = await prisma.tournament.findUnique({ where: { id: BigInt(compId) }, select: { name: true } });
    if (t?.name) {
      compNameCache.set(compId, t.name);
      return t.name;
    }
  } catch { /* 下个心跳重试 */ }
  return undefined;
}

/** 比赛终点兜底缓存（2026-11-27 21:40）：客户端旧 bundle 不带 compEnd 时
 *  服务端查 Tournament.endTime（比赛终点不可变，命中永缓存）。窗口赛的
 *  个人窗口终点可能与比赛终点不同——仅作旧客户端兜底，新客户端以心跳
 *  传来的 sess.endTime 为准 */
const compEndCache = new Map<number, number>();
async function compEndOf(compId: number): Promise<number | undefined> {
  const hit = compEndCache.get(compId);
  if (hit) return hit;
  try {
    const t = await prisma.tournament.findUnique({ where: { id: BigInt(compId) }, select: { endTime: true } });
    if (t?.endTime) {
      const endN = Number(t.endTime);
      if (Number.isFinite(endN) && endN > 0) {
        compEndCache.set(compId, endN);
        return endN;
      }
    }
  } catch { /* 下个心跳重试 */ }
  return undefined;
}

/**
 * 心跳：换局先封口旧局 → 拉权威快照写 pending → 更新 state → final 时封口本局。
 * @param final 局终心跳（finish 消息到达后客户端补发），立即封口本局
 * @param allow 允许旁观（2026-11-27 张老师定）：false 落进 state——观众端判停；
 *   final 心跳照常封口（本局 rep 不丢）
 * @param compId 比赛模式（2026-11-27 20:30 张老师定）：>0＝本局属该比赛
 *   （练习页 comp.id）——state 带 compId/compName 供观众端展示；非比赛局
 *   心跳不带字段，state 自动清空（退出比赛模式直播标记即时切回练习）
 * @param compEnd 比赛倒计时终点（Unix 秒，21:25 张老师定）：随 compId 落
 *   state，旁观页比赛名后剩余时间括号显示 */
export async function heartbeat(uid: number, gameId: string, level: VideoLevel, final: boolean, allow = true, compId?: number, compEnd?: number): Promise<HeartbeatResult> {
  if (!isSafeGameId(gameId)) return { ok: false, error: "gameId 非法" };
  const sealed: string[] = [];
  const prev = getState(uid);
  if (prev && prev.gameId !== gameId) {
    const done = seal(uid, prev.gameId);
    if (done) sealed.push(prev.gameId);
  }

  /* 权威快照：/snapshot 不要求 over/won，进行中局可取（反作弊举报同通道）。
     失败不覆盖 pending——保留上一次成功快照，断线/首击前也不会丢。
     won（2026-11-27 18:54 张老师定）：随手记进 state——封口时 meta 用来
     让观众端优先放已完成局 */
  let snapWon: boolean | undefined;
  let snapProgress: number | undefined;
  let snapScoreMs: number | undefined;
  const label = await playerLabel(uid); // EVF 玩家标识（见 snapshotToEvf 注释），自带缓存
  try {
    const res = await fetch(`${authorityBaseFor(gameId)}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorityAuthHeaders(gameId) },
      body: JSON.stringify({ uid, gameId }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const g = await res.json() as {
        width: number; height: number; mines: number; board: number[];
        bbbv: number; scoreCsec: number; scoreMs?: number;
        nf: boolean; questionMarks: boolean; startedAt?: number; overAt?: number; won?: boolean;
        state?: number[];
        events: { mouse: number; x: number; y: number; sec: number; hun: number; ms?: number }[];
      };
      if (Number.isInteger(g.width) && Number.isInteger(g.height)
        && g.width > 0 && g.height > 0 && g.width <= 40 && g.height <= 40
        && Array.isArray(g.board) && g.board.length === g.width * g.height
        && Array.isArray(g.events)) {
        snapWon = g.won === true;
        snapScoreMs = typeof g.scoreMs === "number" && g.scoreMs >= 0 ? g.scoreMs : undefined;
        /* 完成百分比（2026-11-27 19:21 张老师定；22:11 张老师定终稿＝盘面进度）：
           已开安全格 ÷ 总安全格——权威快照 state 数组（0=未开 1=已开 2/3=旗/问号）
           单遍可算。曾试改 3BV 口径（opening+孤岛数字现算），张老师拍板撤销：
           心跳 3s 一次每次 flood fill 太慢，回到盘面进度 */
        if (Array.isArray(g.state) && g.state.length === g.width * g.height) {
          const safeTotal = g.width * g.height - g.mines;
          if (safeTotal > 0) {
            let opened = 0;
            for (const v of g.state) { if (v === 1) opened++; }
            snapProgress = Math.min(100, Math.max(0, Math.round((opened / safeTotal) * 100)));
          }
        }
        const evf = snapshotToEvf(g, label);
        if (evf.length > 0 && evf.length <= 500_000) atomicWrite(pendingFile(uid, gameId), evf);
      }
    }
  } catch {
    /* 权威取数失败：保留旧 pending（若有） */
  }

  const compIdN = Number.isInteger(compId) && (compId as number) > 0 ? (compId as number) : undefined;
  const compName = compIdN ? await compNameOf(compIdN) : undefined;
  /* compEnd：客户端带值优先（窗口赛=个人窗口终点）；旧 bundle 不带 → 兜底查比赛终点 */
  const compEndN = compIdN && Number.isInteger(compEnd) && (compEnd as number) > 0
    ? (compEnd as number)
    : compIdN
      ? await compEndOf(compIdN)
      : undefined;
  atomicWrite(stateFile(uid), JSON.stringify({
    gameId, lastAt: Date.now(), level, allow,
    won: snapWon, progress: snapProgress, scoreMs: snapScoreMs,
    /* 比赛字段（20:30 张老师定）：非比赛局心跳不带 compId → 不写（state 清空）；
       compName 查库失败时只存 id（观众端降级显示「正在比赛」无链接）；
       compEnd 倒计时终点（21:25 张老师定） */
    ...(compIdN ? { compId: compIdN, ...(compName ? { compName } : {}), ...(compEndN ? { compEnd: compEndN } : {}) } : {}),
  } satisfies LiveRepState));
  if (final) {
    const done = seal(uid, gameId);
    if (done) sealed.push(gameId);
  }
  return { ok: true, sealed };
}

/** 封口：pending → reps，加入 index（去重、限量、过期间缀清理）。返回是否新封口。 */
function seal(uid: number, gameId: string): boolean {
  const pending = pendingFile(uid, gameId);
  if (!existsSync(pending)) return false;
  const idx = getIndex(uid);
  if (idx.reps.some((r) => r.gameId === gameId)) {
    try { unlinkSync(pending); } catch { /* 幂等 */ }
    return false;
  }
  try {
    const st = statSync(pending);
    /* 空壳局（无任何事件）不封口——EVF 解析会失败，观众端白等 */
    if (st.size < 64) { unlinkSync(pending); return false; }
    const rep = repFile(uid, gameId);
    mkdirSync(path.dirname(rep), { recursive: true }); // reps/ 目录首次封口时可能尚不存在
    renameSync(pending, rep);
    /* meta 从 EVF 正解析（v4 头布局不固定）；解析失败退回标准盘尺寸——
       观看页只用 w/h 定棋盘尺寸，bbbv/胜负只留作后台排查（观看不参与排行） */
    let w = 9, h = 9;
    try {
      const v = parseEvf(new Uint8Array(readFileSync(rep)));
      w = v.width; h = v.height;
    } catch { /* 回退标准尺寸 */ }
    const level = getState(uid)?.level ?? "beg";
    const sz = BOARD_SIZE[level] ?? BOARD_SIZE.beg;
    /* won（2026-11-27 18:54 张老师定）：state 记的当前局胜负——换局封口时
       state 还是旧局的（gameId 相符才采信）；final 心跳封口时 state 已带
       最后快照的 won。取不到按未完成（false），只影响观众端选局优先级 */
    const stNow = getState(uid);
    const won = stNow && stNow.gameId === gameId ? stNow.won === true : false;
    /* scoreMs（19:31 张老师定）：state 记的当前局时长——服务端选局用 */
    const scoreMs = stNow && stNow.gameId === gameId ? stNow.scoreMs ?? 0 : 0;
    idx.reps.push({
      gameId,
      level,
      w: w > 0 ? w : sz.x,
      h: h > 0 ? h : sz.y,
      bbbv: 0,
      scoreMs,
      won,
      at: Date.now(),
    });
  } catch {
    return false;
  }
  prune(uid, idx);
  atomicWrite(indexFile(uid), JSON.stringify(idx));
  return true;
}

/** 观众轮询时兜底封口超时局（主播关页/断线、没人发 final 的场景）。
 * 2026-11-27 张老师定：主播关掉「允许旁观」时**不摘 state**——allow=false
 * 留在 state 里，feed 据此区分「主动关闭旁观」与「超时离线」两种停止态。 */
export function sealIfStale(uid: number): boolean {
  const s = getState(uid);
  if (!s || s.allow === false) return false; // 关掉旁观：state 保留（feed 判停口径）
  if (Date.now() - s.lastAt < LIVE_STALE_MS) return false;
  if (seal(uid, s.gameId)) {
    try { unlinkSync(stateFile(uid)); } catch { /* 幂等 */ }
    return true;
  }
  return false;
}

function prune(uid: number, idx: LiveRepIndex) {
  const now = Date.now();
  const keep = idx.reps.filter((r) => now - r.at < KEEP_MS).slice(-KEEP_COUNT);
  const gone = idx.reps.filter((r) => !keep.includes(r));
  idx.reps = keep;
  for (const r of gone) {
    try { unlinkSync(repFile(uid, r.gameId)); } catch { /* 过期文件可能已不在 */ }
  }
}

/** 已封口 rep 的下发 URL——走 /api/live/rep 鉴权路由（2026-11-27 15:30 安全
 *  收口：不再给 public 静态路径，pending/reps 均不对未登录暴露） */
export function repUrl(uid: number, gameId: string): string {
  return isSafeGameId(gameId) ? `/api/live/rep?uid=${uid}&gameId=${gameId}` : "";
}

/** 观看端读取已封口 rep（/api/live/rep 路由调用）。gameId 硬校验（路径穿越
 *  防护）；**只读 reps/**——pending 是进行中局快照、含完整雷位，绝不下发 */
export function readSealedRep(uid: number, gameId: string): Uint8Array | null {
  if (!isSafeGameId(gameId)) return null;
  try {
    return new Uint8Array(readFileSync(repFile(uid, gameId)));
  } catch {
    return null;
  }
}

/** 正在直播的主播摘要（2026-11-27 张老师需求：粉丝端「XXX正在练习」通知）。
 *  判定＝state 心跳新鲜 + allow!==false + **已有至少一条已封口 rep**（玩完
 *  一盘才通知，含踩雷局——封口即算）。全表扫 state.json（主播数有限，
 *  每个一次 readJson，量级 <100） */
export interface LiveStreamer {
  uid: number;
  /** 已封口局数（≥1 才通知） */
  reps: number;
}

export function liveStreamers(): LiveStreamer[] {
  /* 短 TTL 缓存（2026-11-27 15:30 性能收口）：notify 路由是全站登录用户
     60s 轮询的热路径，原实现每次 readdirSync+逐 uid readJson（同步 IO）——
     在线用户一多就是每分钟上百次全量扫盘。3s 缓存对「刚开播延迟通知」
     无感知（气泡本身 60s 轮询）。缓存同样挂 globalThis（跨 bundle 单例） */
  type LSCache = { __liveStreamersCache?: { at: number; data: LiveStreamer[] } };
  const g = globalThis as typeof globalThis & LSCache;
  const c = g.__liveStreamersCache;
  if (c && Date.now() - c.at < 3_000) return c.data;
  try {
    const out: LiveStreamer[] = [];
    for (const name of readdirSync(ROOT)) {
      const uid = Number(name);
      if (!Number.isInteger(uid) || uid <= 0) continue;
      const s = getState(uid);
      if (!s || s.allow === false || Date.now() - s.lastAt >= LIVE_STALE_MS) continue;
      const idx = getIndex(uid);
      /* 玩完一盘（含踩雷局）才通知：封口 rep ≥1（24h 窗口内） */
      if (idx.reps.length < 1) continue;
      out.push({ uid, reps: idx.reps.length });
    }
    g.__liveStreamersCache = { at: Date.now(), data: out };
    return out;
  } catch {
    return [];
  }
}
