"use client";

// 伪直播播放器（2026-11-27 张老师需求，四版终稿）：版式与练习页 /online 完全同款。
//
// 标题行：板块内只放「旁观」（黄 h1）；紧靠标题放「YYY正在练习」——YYY=玩家
// 头像、中文名、性别标记、军衔徽章+称号（正确配色、无边框），筛选器字号 15px；
// 直播红点动态图标紧靠「正在练习」右侧；右上设置/全屏两颗 gicon 永远右对齐
// （margin-left:auto）。页面标题（浏览器标签页）＝「旁观XXX的练习」。
//
// 播放语义：每局只播一次（playedSet）。一局播完进 ended：
// · 数据统计开关（默认开）开 → 左侧统计面板 + 右侧结算面板（完全复用练习页
//   样式：#online_play .greport/.gresult 悬浮在 #game_area，不挤占游戏区）；
//   结算面板含评级 + 雷达图（radarPointsFrom/radarOverall/VideoAnalysisRadar 共享件）。
// · 结算面板唯一按钮「下一局」：队列有未看录像＝金色可点（亮起时开始
//   倒计时）；倒计时内嵌按钮文本「下一局(3)」——统一 N=3 秒（21:44 张老师定，
//   原「短踩雷局<15% 3 秒、其余 5 秒」两档收并）；hover 后倒计时停止并从文本
//   消失，只能手动点击。ended 态下主播新完一局＝按钮再亮再计时。
// · 播完定格终局（14:23/14:24 张老师定）：踩雷局保留已标旗+炸雷 bmb、
//   胜局保留自动补旗（引擎 stop(keepFinal)），与练习页终局一致。
// · 多条待看录像：跳到时长最长的一条，中间跳过的不播。
//
// 滚轮缩放：受限在 .box 容器内（放大溢出回滚本步），不撑破主板块。
//
// 设置浮窗（练习页 #online_play .gsettings 现成规则）：无筛选 Tab，六项——
// 数据统计/声音反馈/像素风格/网页全屏/滚轮缩放/显示比例。默认继承练习页
// online_play_settings，独立落 live_watch_settings / live_watch_zoom_<lv>。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Board } from "@/components/Board";
import { FlopSprites } from "@/components/FlopSprites";
import { DefaultAvatar } from "@/components/DefaultAvatar";
import { RankBadge } from "@/components/RankBadge";
import { AvatarFollowBtn } from "@/components/AvatarFollowBtn";
import { VideoAnalysisRadar } from "@/components/VideoAnalysis";
import {
  parseReplayData,
  runReplay,
  setReplaySndForLive,
  type ReplayData,
  type ReplayStats,
} from "@/components/VideoReplay";
import { statsRows, type StatsRowSource } from "@/lib/replay-core";
import {
  bucketOf,
  DIST_BUCKET_ALL,
  radarOverall,
  radarPointsFrom,
  gradeColor,
  type VideoAnalysisPoint,
} from "@/lib/videoscore";
import { sfxPrefetch } from "@/lib/sfx";
import { toastLoading, toastLoadingDone } from "@/components/Toast";
import { LEVEL_NAMES, MIN_3BV_FOR_3BVS, type VideoLevel } from "@/lib/config";

interface FeedRep {
  gameId: string;
  level: VideoLevel;
  w: number;
  h: number;
  /** 主播该局是否完成（2026-11-27 18:54 张老师定：选局优先已完成，失败尝试跳过） */
  won?: boolean;
  url: string;
  at: number;
}

type Phase = "loading" | "playing" | "waiting" | "ended";

/** 主播身份（SSR 传入：头像/中文名/性别/称号） */
export interface LiveHost {
  name: string;
  pinyin: string;
  sex: number;
  avatar: string;
  isDefault: boolean;
  title: string;
  titleColor: string;
}

/* 独立设置（观看页专用键；缺省＝继承练习页 online_play_settings 同名值） */
const LIVE_LS_KEY = "live_watch_settings";
const LIVE_ZOOM_KEY = (lv: VideoLevel) => `live_watch_zoom_${lv}`;
interface LiveSettings {
  stats: boolean;
  sndFb: boolean;
  pixelStyle: boolean;
  webFullscreen: boolean;
  wheelZoom: boolean;
}
const PLAY_LS_KEY = "online_play_settings";
const PLAY_ZOOM_KEY = (lv: VideoLevel) => `online_play_zoom_${lv}`;

function readSettings(): LiveSettings {
  const def: LiveSettings = { stats: true, sndFb: true, pixelStyle: false, webFullscreen: false, wheelZoom: true };
  try {
    const raw = localStorage.getItem(PLAY_LS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Record<string, unknown>;
      if (typeof s.showStats === "boolean") def.stats = s.showStats;
      if (typeof s.sndFb === "boolean") def.sndFb = s.sndFb;
      if (typeof s.pixelStyle === "boolean") def.pixelStyle = s.pixelStyle;
      if (typeof s.webFullscreen === "boolean") def.webFullscreen = s.webFullscreen;
      if (typeof s.wheelZoom === "boolean") def.wheelZoom = s.wheelZoom;
    }
  } catch { /* 隐私模式/脏数据 */ }
  try {
    const raw = localStorage.getItem(LIVE_LS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Record<keyof LiveSettings, boolean>>;
      const out = { ...def };
      if (typeof s.stats === "boolean") out.stats = s.stats;
      if (typeof s.sndFb === "boolean") out.sndFb = s.sndFb;
      if (typeof s.pixelStyle === "boolean") out.pixelStyle = s.pixelStyle;
      if (typeof s.webFullscreen === "boolean") out.webFullscreen = s.webFullscreen;
      if (typeof s.wheelZoom === "boolean") out.wheelZoom = s.wheelZoom;
      return out;
    }
  } catch { /* 同上 */ }
  return def;
}
function writeSettings(s: LiveSettings) {
  try { localStorage.setItem(LIVE_LS_KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ }
}
function readZoom(lv: VideoLevel): number {
  try {
    const own = parseFloat(localStorage.getItem(LIVE_ZOOM_KEY(lv)) ?? "");
    if (own > 0) return own;
    const play = parseFloat(localStorage.getItem(PLAY_ZOOM_KEY(lv)) ?? "");
    if (play > 0) return play;
  } catch { /* 隐私模式 */ }
  return 1;
}
function writeZoom(lv: VideoLevel, v: number) {
  try { localStorage.setItem(LIVE_ZOOM_KEY(lv), String(v)); } catch { /* 隐私模式 */ }
}

/* LED 数码管渲染（练习页 led 同款） */
function ledRender(el: SVGElement | null, v: number) {
  if (!el) return;
  const uses = el.querySelectorAll<SVGElement>("use.d");
  if (uses.length < 3) return;
  v = Math.max(-99, Math.min(999, Math.round(v)));
  const a = Math.abs(v);
  const ds: (string | number)[] =
    v < 0 ? ["minus", ((a / 10) | 0) % 10, a % 10] : [((a / 100) | 0) % 10, ((a / 10) | 0) % 10, a % 10];
  for (let k = 0; k < 3; k++) uses[k].setAttribute("href", "#count-" + ds[k]);
}

const FACE_MAP: Record<string, string> = {
  smile: "face-normal", ooh: "face-press-cell", dead: "face-lose",
  win: "face-win", press: "face-press-normal",
};

/** 结算雷达五轴（练习页 computeRadarPoints/buildResultPanel 同口径：
 * t=秒、est=t×3BV÷已完成3BV（败局半成品速度按 Est 折算）、
 * bvs=solvedBv/est、thrp=solvedBv/ce、ces=ce/t、cps=crossings/t、
 * bpp=solvedBv/crossings。池按 级别×模式 组内，初级运气盘 3bvs/stnb 摘除） */
function liveRadarPoints(
  st: ReplayStats,
  level: VideoLevel,
  nf: boolean, /* 事件流无法判 NF（EVF 里有 mode 位，但观看页恒按 FL 池评） */
  metricDists: Record<string, Record<string, Record<string, number[]>>>,
): VideoAnalysisPoint[] {
  const t = st.ms / 1000;
  const cl = st.clLeft + st.clRight + st.clDouble;
  const hasBv = st.solvedBv > 0 && t > 0;
  const est = hasBv ? t * (st.board3bv / st.solvedBv) : 0;
  const distLevel = level;
  /* 池 key（getOnlineMetricDists 口径）：FL＝裸级别（int）、NF＝int_nf。
   * ⚠️ 不是 int_fl（旧笔误：池恒 undefined → 全轴无评级、雷达收缩成点
   *   ——2026-11-27 14:24 张老师报「胜局雷达图没显示」根因） */
  const key = distLevel + (nf ? "_nf" : "");
  const pool = metricDists[key];
  const bk = bucketOf(distLevel, st.board3bv);
  const bucketRow = pool?.[String(bk)];
  const wholeRow = pool?.[String(DIST_BUCKET_ALL)];
  const group = bucketRow ?? wholeRow;
  const groupDists: Record<string, number[]> = {};
  if (group?.bpp) groupDists.bpp = group.bpp;
  if (wholeRow?.time) groupDists.time = wholeRow.time;
  if (wholeRow?.bvs) groupDists.bvs = wholeRow.bvs;
  if (wholeRow?.stnb) groupDists.stnb = wholeRow.stnb;
  if (wholeRow?.thrp) groupDists.thrp = wholeRow.thrp;
  if (wholeRow?.ces) groupDists.ces = wholeRow.ces;
  if (wholeRow?.cps) groupDists.cps = wholeRow.cps;
  if (distLevel === "beg" && st.board3bv < MIN_3BV_FOR_3BVS.beg) {
    delete groupDists.bvs;
    delete groupDists.stnb;
  }
  const lowCompletion = st.board3bv <= 0 || st.solvedBv / st.board3bv < 0.1;
  const rateable = !!group && cl > 0 && !lowCompletion;
  return radarPointsFrom(
    {
      time: hasBv ? est : 0,
      bvs: hasBv ? st.solvedBv / est : 0,
      thrp: st.ce > 0 ? st.solvedBv / st.ce : 0,
      ces: t > 0 && st.ce > 0 ? st.ce / t : 0,
      cps: t > 0 && st.cp > 0 ? st.cp / t : 0,
      bpp: st.cp > 0 ? st.solvedBv / st.cp : 0,
    },
    groupDists,
    rateable,
    false,
    undefined,
    `${(LEVEL_NAMES as Record<string, string>)[distLevel] ?? distLevel}FL玩家`,
    null,
  );
}

export function LiveWatch({ uid, host, initiallyLive, metricDists, initialComp }: {
  uid: number;
  host: LiveHost;
  initiallyLive: boolean;
  /** 评级基准分布池（SSR 取 getOnlineMetricDists，与练习页同源） */
  metricDists: Record<string, Record<string, Record<string, number[]>>>;
  /** 比赛模式（2026-11-27 20:30 张老师定）：SSR 从 state.json 带出（心跳落盘）
   *  的当前比赛——标题行「正在参加xxx（剩余…）」（详情页新标签链接）；轮询随 feed 刷新 */
  initialComp: { id: number; name: string; end?: number } | null;
}) {
  const [phase, setPhase] = useState<Phase>("waiting");
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(initiallyLive);
  /* 旁观数（2026-11-27 14:18 张老师需求）：红点后「x人正在旁观」 */
  const [viewerCount, setViewerCount] = useState(0);
  /* 主播当前局完成百分比（2026-11-27 19:21 张老师定）：已开安全格占比，
     feed 直播中带回——「对局中」气泡/按钮显示；停止/离线为 null */
  const [progress, setProgress] = useState<number | null>(null);
  /* 主播当前局 gameId（2026-11-27 22:29 张老师定）：与观众最近看完的录像
     gameId 对比——相同＝主播还停在上一局结算画面未开新局（「等待玩家开始」，
     不显示旧局进度残留）；不同＝主播已开新局还在局中（「对局中」+进度） */
  const [curGameId, setCurGameId] = useState<string | null>(null);
  const [lastPlayedId, setLastPlayedId] = useState<string | null>(null);
  /* 录像放完时刻（22:29 张老师定倒计时规则）：ended 后 ≤3s 内候选到达
     才出倒计时，>3s 直接连播不出倒计时 */
  const endedAtRef = useRef<number | null>(null);
  /* 比赛模式（2026-11-27 20:30 张老师定）：直播中主播在比赛——标题行
     「正在练习」换「正在参加{全名}（剩余…）」（新标签详情页链接）；
     离线/非比赛 null */
  const [comp, setComp] = useState<{ id: number; name: string; end?: number } | null>(initialComp);
  /* 比赛剩余时间显示时钟（21:25 张老师定）：30s tick——客户端组件内取
     Date.now() 合法（RSC 渲染期禁 Date.now 的铁律只限服务端组件）；
     null＝SSR 初帧不显示括号，水合后 30s 内出现 */
  const [nowSec, setNowSec] = useState<number | null>(null);
  useEffect(() => {
    const upd = () => setNowSec(Math.floor(Date.now() / 1000));
    upd();
    const t = window.setInterval(upd, 30_000);
    return () => window.clearInterval(t);
  }, []);
  /* 主播离开（2026-11-27 张老师 13:01 定）：不再用红气泡——直接切换到
     「XXX没有在练习」引导页形态（与未关注引导页同版式） */
  const [stopped, setStopped] = useState(false);
  /* 中途被拒（2026-11-27 20:23 张老师定）：观看中主播把我拉黑/取关 → feed 403
     ＝终态拒绝，整页切「由于该玩家的隐私设置，你无法旁观」（与 SSR 入口面板
     同文案）；轮询照跑——解除拉黑/重新关注后 200 自动恢复观看 */
  const [denied, setDenied] = useState<string | null>(null);
  /* stopped 的 ref 镜像：轮询回调里判「已停止」（避免依赖数组加 stopped
     导致轮询 effect 重建）；主播恢复直播时复位（15:11 张老师定） */
  const stoppedRef = useRef(false);
  /* 服务端选定的下一条待播录像（2026-11-27 19:31 张老师定：feed 只回一条
     决策结果，不再下发全量队列）；null＝没有该看的（对局中/未开始） */
  const [nextRep, setNextRep] = useState<FeedRep | null>(null);
  /* 当前决策里被跳过的局（与选中的同批候选——起播时一并标已播，跳播语义） */
  const [skipped, setSkipped] = useState<string[]>([]);
  /* 棋盘级别：起播时随录像切换（等待/空闲保持上一局级别，不回默认） */
  const [level, setLevel] = useState<VideoLevel>("beg");
  const [stats, setStats] = useState<ReplayStats | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null); // null=不倒计时（hover 或无下一局）
  const [settings, setSettings] = useState<LiveSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [webFs, setWebFs] = useState(false);
  /* 原生全屏态（2026-11-27 18:20 张老师定：全屏中按钮变金色，退出复原）
     ——fullscreenchange 是浏览器事件不触发 React 重渲染，必须 state 化 */
  const [fsNative, setFsNative] = useState(false);
  /* webFs 的 ref 镜像：feed 轮询回调（deps=[uid] 不含 state）里判网页全屏态 */
  const webFsRef = useRef(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const gwrapRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLDivElement | null>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const ledMinesRef = useRef<SVGSVGElement | null>(null);
  const ledTimeRef = useRef<SVGSVGElement | null>(null);
  const faceUseRef = useRef<SVGUseElement | null>(null);
  const engineRef = useRef<ReturnType<typeof runReplay> | null>(null);
  const cursorRef = useRef<HTMLElement | null>(null);
  /* playNext 重入闸（loading 阶段 engineRef 还是 null） */
  const playBusyRef = useRef(false);
  /* 当前正在播放的局（2026-11-27 21:03 张老师定：主播 AFK 切局判定用——
     播放中该局未标已播，服务端「时长最长」选局仍会推它当 best，新局只在
     skipped 里出现；playNext 起播时记录，onEnd/中断后失效） */
  const playingGameIdRef = useRef<string | null>(null);
  /* nextRep/skipped 的 ref 镜像：playNext/onEnd 等回调闭包里读最新值 */
  const nextRepRef = useRef<FeedRep | null>(null);
  const skippedRef = useRef<string[]>([]);
  const playedRef = useRef<Set<string>>(new Set()); // 已播 gameId：每局只播一次
  const dataCache = useRef<Map<string, ReplayData>>(new Map());
  const fetchSeq = useRef(0);
  const zoomRef = useRef(1);
  const settingsRef = useRef<LiveSettings | null>(null);
  const wheelAcc = useRef(0);
  const wheelTimer = useRef<number | null>(null);
  const lastStatsRef = useRef<ReplayStats | null>(null);
  const countdownTimerRef = useRef<number | null>(null);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { nextRepRef.current = nextRep; }, [nextRep]);
  useEffect(() => { skippedRef.current = skipped; }, [skipped]);

  const setFace = useCallback((k: string) => {
    const el = faceUseRef.current;
    if (el) el.setAttribute("href", "#" + (FACE_MAP[k] ?? FACE_MAP.smile));
  }, []);

  useEffect(() => {
    const s = readSettings();
    setSettings(s);
    settingsRef.current = s;
    setReplaySndForLive(s.sndFb);
    if (s.sndFb) sfxPrefetch([
      "/sounds/pop1.mp3", "/sounds/pop2.mp3", "/sounds/pop3.mp3", "/sounds/pop4.mp3",
      "/sounds/pop5.mp3", "/sounds/pop6.mp3", "/sounds/pop7.mp3", "/sounds/flag.mp3", "/sounds/chord.mp3",
    ]);
    return () => { setReplaySndForLive(true); };
  }, []);

  const stopEngine = useCallback((keepFinal = true) => {
    /* keepFinal（2026-11-27 14:23 张老师定）：定格终局盘面——踩雷局保留
       已标旗+炸雷 bmb 标记、胜局保留自动补旗，与练习页终局一致（旧 stop
       恢复静态封面＝「重置」观感）。下一局起播由引擎 resetReplay 全清。
       keepFinal=false（主播停止切引导页时）：完整重置——返回后空白地图 */
    engineRef.current?.stop(keepFinal);
    engineRef.current = null;
    cursorRef.current?.remove();
    cursorRef.current = null;
  }, []);

  /* 网页全屏形态切换（练习页 setWebFs 口径）：只管类开关，被全屏按钮/
     开关关闭路径调用（声明在 feed 轮询之前——stopped 分支要调它退全屏） */
  const applyWebFs = useCallback((onF: boolean) => {
    rootRef.current?.classList.toggle("op-webfs", onF);
    document.documentElement.classList.toggle("op-webfs", onF);
    webFsRef.current = onF;
    setWebFs(onF);
  }, []);

  /* 原生全屏态跟踪（金色按钮）：进入/退出都同步（含组件树外触发的 ESC） */
  useEffect(() => {
    const onFs = () => setFsNative(document.fullscreenElement === rootRef.current && !!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* 观看收尾（主播离开 stopped / 中途被拒 denied 两路共用）：遮罩面板搬回
     React 树再摘、退两种全屏、引擎硬重置、终局状态清空——2026-11-27 20:23
     从 stopped 分支抽出（中途被拉黑同样可能正在全屏观看/气泡常驻） */
  const teardownPlayback = useCallback(() => {
    const host = modalHostRef.current;
    const ga = gameAreaRef.current;
    if (host && ga) {
      const rep = reportRef.current;
      const res = resultRef.current;
      if (res && res.parentElement !== ga) ga.appendChild(res);
      if (rep && rep.parentElement !== ga) ga.appendChild(rep);
      host.hidden = true;
      host.remove();
      modalHostRef.current = null;
    }
    stoppedRef.current = true;
    if (webFsRef.current) applyWebFs(false);
    if (document.fullscreenElement) {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
    stopEngine(false);
    lastStatsRef.current = null;
    setStats(null);
    setCountdown(null);
    setStopped(true);
  }, [applyWebFs, stopEngine]);

  /* feed 轮询：3s 一次 */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        /* played（19:31 张老师定）：已看过的 gameId 上报给服务端选局——
           只回传最近 40 条（队列窗口 ≤20/24h，更旧的必然已过期） */
        const playedQs = encodeURIComponent([...playedRef.current].slice(-40).join(","));
        const r = await fetch(`/api/live/feed?uid=${uid}&played=${playedQs}`, { cache: "no-store" });
        if (!alive) return;
        if (!r.ok) {
          const j = await r.json().catch(() => null) as { error?: string } | null;
          if (r.status === 403) {
            /* 中途被拉黑/取消关注（2026-11-27 20:23 张老师定）：终态拒绝
               整页提示，收尾同 stopped（面板搬回/退全屏/停引擎） */
            teardownPlayback();
            setDenied(j?.error || "由于该玩家的隐私设置，你无法旁观");
            return;
          }
          setErr(j?.error || "连接失败");
          return;
        }
        const j = await r.json() as {
          ok: boolean; live: boolean; viewers?: number; progress?: number | null;
          curGameId?: string | null;
          comp?: { id: number; name: string; end?: number } | null;
          rep?: FeedRep | null; skipped?: string[]; lastLevel?: VideoLevel | null;
        };
        if (!alive) return;
        setErr(null);
        setDenied(null); /* 拒绝态已解除（拉黑撤销/重新关注）→ 回观看流 */
        setLive(j.live);
        /* 服务端选局结果：单条候选 + 同批跳过的局（空＝没有该看的） */
        nextRepRef.current = j.rep ?? null;
        setNextRep(j.rep ?? null);
        skippedRef.current = j.skipped ?? [];
        setSkipped(j.skipped ?? []);
        /* 旁观数（2026-11-27 14:18 张老师需求）：标题行「x人正在旁观」
           （数字亮灰、文字深灰）；feed 响应带回 */
        setViewerCount(typeof j.viewers === "number" ? j.viewers : 0);
        /* 当前局完成百分比（19:21 张老师定）：直播中显示在气泡/按钮 */
        setProgress(typeof j.progress === "number" ? j.progress : null);
        /* 主播当前局 gameId（22:29 张老师定）：判「等待玩家开始」vs「对局中」 */
        setCurGameId(typeof j.curGameId === "string" ? j.curGameId : null);
        /* 比赛模式（20:30 张老师定）：直播中随心跳 state 刷新（进出比赛即时切换） */
        setComp(j.comp && j.comp.name ? j.comp : null);
        /* 主播 AFK 切局（2026-11-27 21:03 张老师定）：正在播的局鼠标累计
           5 秒不动（主播开局后中途离开做其他事——录像又长又无操作），而
           feed 出现了新局 → 中断当前局直接等下一局（下轮 poll ≤3s 送达，
           waiting+候选自动起播）。新局识别：播放中该局未标已播，服务端
           「时长最长」选局仍会把它当 best 推回——新局要么顶替 best
           （rep.gameId 不同，won 优先时），要么落在 skipped 里。
           检测口径：录像时间轴上距最近已应用事件 ≥500 百分秒（5 秒无任何
           鼠标事件）；中断动作＝当前局标已播（不回看）+清候选+停引擎回
           waiting——AFK 局不算终局画面，盘面硬重置 */
        if (engineRef.current && playingGameIdRef.current) {
          const curGame = playingGameIdRef.current;
          const newGame = j.rep && j.rep.gameId !== curGame
            ? j.rep.gameId
            : (j.skipped ?? []).find((g) => g !== curGame);
          if (newGame && engineRef.current.idleCsec() >= 500) {
            playedRef.current.add(curGame);
            nextRepRef.current = null;
            setNextRep(null);
            skippedRef.current = [];
            setSkipped([]);
            setCountdown(null);
            stopEngine(false);
            setPhase("waiting");
            playingGameIdRef.current = null;
          }
        }
        /* 主播停止练习（2026-11-27 张老师定）：开过直播（曾 live）后转为不 live
           ＝主播退出练习页或关闭允许旁观——直接切换到「XXX没有在练习」引导页。
           切换前先把终局面板收干净（14:51 张老师定：遮罩面板一并消失）：
           遮罩形态下面板被 place() appendChild 挪进 body #gr_modal（React
           树外），分支切换卸载旧树时 React 挪走的节点删不掉会残留——
           先搬回 game_area（React 记录的父位）再摘遮罩，卸载即可正常回收。
           19:02 张老师定：**还有待播录像（服务端决策候选在）或引擎正在播时
           不切 stopped**——主播玩完最后一局就走，观众要等最后一局放完再切
           引导页，否则最后一局看不到；主播断线未发 final 的超时局由观众
           轮询 sealIfStale 兜底封口，≤12s 必进队列，不会永远卡住 */
        if (!j.live && liveOnceRef.current && !stoppedRef.current) {
          if (nextRepRef.current === null && engineRef.current === null) {
            /* 清理逻辑（面板搬回/退全屏/停引擎/清状态）已抽至 teardownPlayback
               （2026-11-27 20:23：与中途被拒 denied 分支共用） */
            teardownPlayback();
          }
        }
        /* 主播恢复直播（2026-11-27 15:11 张老师定）：stopped 不是终态——
           停止期间轮询照跑，live 一恢复马上撤引导页回到观看。18:39 定：
           恒回 waiting 空白地图（面板已在停止时清空），有未播局起播无则等新局 */
        if (j.live) {
          liveOnceRef.current = true;
          if (stoppedRef.current) {
            stoppedRef.current = false;
            setStopped(false);
            setPhase("waiting");
          }
        }
      } catch {
        if (alive) setErr("网络异常，正在重试…");
      }
    };
    void poll();
    const timer = window.setInterval(poll, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [uid, applyWebFs, stopEngine, teardownPlayback]);
  const liveOnceRef = useRef(initiallyLive);

  /* 起播：消费服务端选局结果（nextRepRef）——选中局 + 同批跳过局全部标
     已播（跳播语义）；级别随录像切换。重入闸防 loading 阶段二次起播 */
  const playNext = useCallback(async () => {
    if (engineRef.current || playBusyRef.current) return;
    const next = nextRepRef.current;
    const wrap = wrapRef.current;
    const boardEl = boardRef.current;
    if (!next || !wrap || !boardEl) {
      setPhase("waiting");
      return;
    }
    playBusyRef.current = true;
    const seq = ++fetchSeq.current;
    /* 当前局登记（主播 AFK 切局判定用，见 playingGameIdRef 注释） */
    playingGameIdRef.current = next.gameId;
    /* 选中局与跳过的中间局直接入 played（张老师口径：不再播放） */
    playedRef.current.add(next.gameId);
    for (const id of skippedRef.current) playedRef.current.add(id);
    nextRepRef.current = null;
    setNextRep(null);
    skippedRef.current = [];
    setSkipped([]);
    const tbody = boardEl.querySelector("tbody");
    if (!tbody) { playBusyRef.current = false; return; }
    setLevel(next.level);
    setLastPlayedId(next.gameId); /* 最近看完的局（22:29 张老师定：与 curGameId 对比判「等待玩家开始」） */
    setPhase("loading");
    /* 面板隐藏（19:06 张老师定：播放过程中统计/结算面板都不显示；
       新一局终局 onEnd 再刷新 stats） */
    setStats(null);
    setCountdown(null);
    setFace("smile");
    try {
      let data: ReplayData | undefined = dataCache.current.get(next.gameId);
      if (!data) {
        const res = await fetch(next.url, { cache: "no-store" });
        if (!res.ok) throw new Error("rep 加载失败");
        const parsed = parseReplayData(new Uint8Array(await res.arrayBuffer()), "evf");
        if (!parsed) throw new Error("rep 解析失败");
        data = parsed;
        dataCache.current.set(next.gameId, data);
      }
      if (seq !== fetchSeq.current || !wrap.isConnected) return;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const rows = tbody.rows.length;
      const cols = rows ? tbody.rows[0].cells.length : 0;
      if (!rows || !cols || seq !== fetchSeq.current) return;
      engineRef.current = runReplay({
        wrap,
        tbody: tbody as HTMLTableSectionElement,
        rows,
        cols,
        data,
        onEnd: () => {
          stopEngine();
          endedAtRef.current = Date.now(); /* 22:29 张老师定：倒计时 3 秒窗口起点 */
          setPhase("ended");
          if (settingsRef.current?.stats && lastStatsRef.current) setStats(lastStatsRef.current);
          /* 倒计时与自动连播由下方 pending/level 效果接管（候选可能要等
             下一个轮询才到——19:31 服务端选局后 onEnd 不再同步可判） */
        },
        onStats: (st) => {
          lastStatsRef.current = st;
          /* LED 雷数：胜局清零（stats.won 引擎终态——flags 推算对自动补旗恒误判） */
          ledRender(ledMinesRef.current, st.won ? 0 : st.totalMines - st.flags);
          ledRender(ledTimeRef.current, Math.floor(st.csec / 100));
        },
        onFace: (k) => setFace(k),
      });
      cursorRef.current = wrap.querySelector<HTMLElement>(".replay_cursor");
      setPhase("playing");
    } catch {
      setPhase("waiting");
    } finally {
      playBusyRef.current = false;
    }
  }, [stopEngine, setFace]);

  /* 等待态有候选即起播（候选由 feed 轮询送达；每次轮询候选对象身份更新，
     waiting 下逐轮重试起播） */
  useEffect(() => {
    if (phase === "waiting" && nextRep !== null) void playNext();
  }, [nextRep, phase, playNext]);

  /* 倒计时 tick：每秒递减，归零自动播下一局；hover「下一局」按钮时暂停
     （张老师 2026-11-27 定：提示消失、只能手动点击） */
  useEffect(() => {
    if (countdown === null) {
      if (countdownTimerRef.current !== null) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      return;
    }
    if (countdown <= 0) {
      setCountdown(null);
      void playNext();
      return;
    }
    countdownTimerRef.current = window.setInterval(() => {
      setCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) return 0; // 归零：下一轮 effect 触发自动播
        return c - 1;
      });
    }, 1000);
    return () => {
      if (countdownTimerRef.current !== null) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [countdown, playNext]);

  /* 手动点「下一局」：回 waiting（面板随即隐藏，19:06 张老师定） */
  const onNextClick = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
    setStats(null);
    setPhase("waiting");
  }, []);

  /* hover 下一局按钮（2026-11-27 14:25 张老师定）：倒计时停止并从按钮
     文本消失，只能手动点击。hover 后 countdown 恒置 null（onEnd 不再重启
     ——本轮 effect 依赖 countdown=null 清 interval；离开按钮也不恢复，
     直到下次 ended） */
  const onNextHover = useCallback((on: boolean) => {
    if (on) {
      hoverHoldRef.current = true; /* hover 保持：pending 不变不复活计时 */
      if (countdownTimerRef.current !== null) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      setCountdown(null);
    }
  }, []);

  useEffect(() => () => {
    fetchSeq.current++;
    stopEngine();
    if (countdownTimerRef.current !== null) clearInterval(countdownTimerRef.current);
  }, [stopEngine]);

  /* 级别状态（起播时随录像切换，见 playNext）：驱动棋盘尺寸/级别切换 */
  const dim = level === "exp" ? { x: 30, y: 16 } : level === "int" ? { x: 16, y: 16 } : { x: 8, y: 8 };
  const seed = "b".repeat(dim.x * dim.y);

  const levelRef = useRef<VideoLevel>("beg");
  useEffect(() => {
    levelRef.current = level;
    const z = readZoom(level);
    setZoom(z);
    zoomRef.current = z;
  }, [level]);

  useEffect(() => {
    /* deps 带 stopped（2026-11-27 18:39 张老师定）：主播停止→返回后观看树
       整棵重建（gwrap 新元素），zoom/level 未变 effect 不会自己重跑——
       挂 stopped 变化强制重放记忆倍率，游戏区域保持此前比例不回默认 */
    if (gwrapRef.current) gwrapRef.current.style.zoom = String(zoom);
  }, [zoom, level, stopped]);

  /* 终局面板定位（2026-11-27 13:18 报障根修 / 13:26+13:29 定稿）：
     **与练习页复用同一套布局逻辑**（syncReportZoom/sideFit/placeSide 的
     观看页移植）——
     · 侧位：面板 zoom 与游戏倍率同步（zoomCur，>1.5 时以棋盘高封顶），
       再按侧空/视口高/数据面板高线性收缩；左面板右缘贴银框左−14、
       右面板左缘贴银框右+14、顶与银框对齐；坐标 = 渲染域 ÷ pz ÷ 面板 zoom。
     · 侧位放不下 → 整组搬进 #gr_modal 遮罩卡片居中（enterMask 口径——DOM
       搬家不重建，雷达/按钮/倒计时不丢；进遮罩清 inline 定位与缩放，点遮罩
       空白收卡片、面板搬回 game_area）。
     **侧空按视口量（2026-11-28 00:06 张老师定「面板应该是浮动的，不受主板块
       限制，和练习页逻辑一致」）**：面板挂 #game_area 但 left 可为负、溢出
       .box 浮到视口两侧——练习页 sideFit 逐字口径 `gw.left - 12 - 14` /
       `innerWidth - gw.right - 12 - 14`。此前误按「game_area 内余量」判侧空
       （#page.main 限宽 960，高级盘几乎占满 → 宽屏也恒走遮罩）。
     阈值同练习页：≥960 且两面板侧位渲染宽都 ≥120px，否则遮罩。
     依赖 [phase, stats, zoom, level] 重摆 + 120ms 二次复核（雷达异步落地） */
  const modalHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const ga = gameAreaRef.current;
    const gr = gwrapRef.current;
    const rep = reportRef.current;
    const res = resultRef.current;
    if (!ga || !gr || !rep || !res) return;
    if (phase !== "ended" || !stats) {
      /* 非终局（含播放中——19:06 张老师定面板隐藏）或无数据：收遮罩、
         面板归位清缩放（状态切换时 effect 重跑自然清） */
      const host = modalHostRef.current;
      if (host && !host.hidden) host.hidden = true;
      if (rep.parentElement !== ga && rep.parentElement !== null) ga.appendChild(rep);
      if (res.parentElement !== ga && res.parentElement !== null) ga.appendChild(res);
      rep.style.zoom = "";
      res.style.zoom = "";
      rep.style.visibility = "";
      res.style.visibility = "";
      return;
    }
    /* 进遮罩（enterMask 口径）：建宿主（首次）、面板搬进卡片、清 inline 定位
       与缩放，卡片 flex 接管 */
    const enterMask = () => {
      let host = modalHostRef.current;
      if (!host) {
        const h = document.createElement("div");
        h.id = "gr_modal";
        h.innerHTML = '<div class="grm_card"><div class="grm_slot" id="lv_grm_result"></div><div class="grm_slot" id="lv_grm_stats"></div></div>';
        document.body.appendChild(h);
        modalHostRef.current = h;
        /* 点遮罩空白收卡片：面板搬回 game_area 并隐藏（裸露在 game_area
           左上角会盖住棋盘——下次 place() 侧位/遮罩判定时再恢复显示） */
        h.addEventListener("click", (e) => {
          if (e.target !== h) return;
          h.hidden = true;
          ga.appendChild(res);
          ga.appendChild(rep);
          res.style.visibility = "hidden";
          rep.style.visibility = "hidden";
        });
        host = h;
      }
      host.hidden = false;
      rep.style.left = "";
      rep.style.top = "";
      rep.style.zoom = "";
      res.style.left = "";
      res.style.top = "";
      res.style.zoom = "";
      rep.style.visibility = "";
      res.style.visibility = "";
      host.querySelector("#lv_grm_result")?.appendChild(res);
      host.querySelector("#lv_grm_stats")?.appendChild(rep);
    };
    const place = () => {
      /* 已脱离文档（主播停止切引导页——观看树被 React 替换，闭包里的
         ga/gr/rep/res 全成 detached 节点）时绝不再摆：否则 ESC 退出全屏
         触发 fullscreenchange → repl → place() 会把 detached 面板重新
         挂进新建的 #gr_modal，遮罩和结算面板「复活」在引导页上
         （2026-11-27 18:20 张老师报障根因） */
      if (!ga.isConnected || !gr.isConnected || !rep.isConnected || !res.isConnected) return;
      const gw = gr.getBoundingClientRect();
      const gaR = ga.getBoundingClientRect();
      /* 布局未就绪守卫（2026-11-27 22:29 张老师报 Safari 误进遮罩）：矩形
         尺寸还没量出来（字体/雷达落地前的瞬态）时不下判定——等重测链补测，
         一次误判会把面板锁死在遮罩里（ended 后无其他重摆触发） */
      if (gw.width < 40 || ga.clientWidth < 40) return;
      const pz = 1; /* #page 在 ≥960 恒 1（窄屏走遮罩，不进侧位路径） */
      const zGame = zoomRef.current;
      /* 窄屏恒遮罩（练习页 mqPanelDesktop 同口径）：.show 只在 ≥960 生效，
         窄屏面板 display:none 量不出，不进侧位路径 */
      if (!window.matchMedia("(min-width: 960px)").matches) {
        enterMask();
        return;
      }
      /* 面板先归位 game_area 再量：挂遮罩卡片时被 flex 拉伸（结算面板
         width:100%），量出的不是自然尺寸。同一任务内搬→量→判定→再落位，
         无中间帧闪烁 */
      if (rep.parentElement !== ga) ga.appendChild(rep);
      if (res.parentElement !== ga) ga.appendChild(res);
      rep.style.visibility = "";
      res.style.visibility = "";
      /* 1x 自然尺寸（练习页 panelNatural 口径：zoom 归 1 再量，每轮重量） */
      const measure = (p: HTMLElement) => {
        const saveZ = p.style.zoom;
        p.style.zoom = "";
        const r = { w: p.offsetWidth, h: p.offsetHeight };
        p.style.zoom = saveZ;
        return r;
      };
      const baseRep = measure(rep);
      const baseRes = measure(res);
      /* sideFit（练习页逐字口径）：naturalZ＝游戏倍率（面板与游戏同步缩放），
         大倍率高盘时以「面板高＝棋盘渲染高」封顶；侧空按**视口**量（视口缘
         12 + 面板间隙 14）、视口高再线性收缩。maxRenderedH＝渲染高上限 */
      const sideFit = (b: { w: number; h: number }, availSide: number, maxRenderedH?: number) => {
        const gameCapH = zGame > 1.5 && gw.height > 1 ? gw.height / (b.h * pz) : 2.5;
        const naturalZ = Math.max(0.3, Math.min(zGame, gameCapH, 2.5));
        const sideCap = b.w > 1 ? availSide / (b.w * pz) : 2.5;
        const hCap = b.h > 1 ? (window.innerHeight - 12 - gw.top) / (b.h * pz) : 2.5;
        const hMax = maxRenderedH != null && b.h > 1 ? maxRenderedH / (b.h * pz) : 2.5;
        const z = Math.max(0.25, Math.min(naturalZ, sideCap, hCap, hMax));
        return { z, renderedW: b.w * z * pz };
      };
      /* 侧空按视口量（练习页 sideFit 逐字）——面板浮动到主板块之外 */
      const availLeft = gw.left - 12 - 14;
      const availRight = window.innerWidth - gw.right - 12 - 14;
      const statsFit = sideFit(baseRep, availLeft);
      /* 结算面板渲染高封顶＝数据面板渲染高（练习页 2026-10-19 口径） */
      const resultMaxH = baseRep.h > 1 ? statsFit.z * baseRep.h * pz : undefined;
      const resultFit = sideFit(baseRes, availRight, resultMaxH);
      /* 阈值判定（练习页 PANEL_MIN_W 同值）：任一面板按侧位公式摆出来都不到
         120px 渲染宽 → 侧位没有意义，转遮罩 */
      if (statsFit.renderedW < 120 || resultFit.renderedW < 120) {
        enterMask();
        return;
      }
      /* 侧位路径：面板在 game_area（上面已归位）、遮罩隐藏 */
      if (modalHostRef.current && !modalHostRef.current.hidden) modalHostRef.current.hidden = true;
      /* placeSide（练习页逐字口径）：put 后底部越出视口按高度比再压一档；
         返回实际生效 zoom（末段兜底收缩后可能 < 入参，结算封顶要用它） */
      const placeSide = (panel: HTMLElement, side: "left" | "right", baseW: number, z: number): number => {
        const put = (zz: number) => {
          const t = (v: number) => v / pz / zz;
          panel.style.zoom = String(zz);
          panel.style.top = t(gw.top - gaR.top) + "px";
          panel.style.left = side === "left"
            ? t(gw.left - gaR.left - 14) - baseW + "px"
            : t(gw.right - gaR.left + 14) + "px";
        };
        put(z);
        let zFinal = z;
        const now = panel.getBoundingClientRect();
        if (now.bottom > window.innerHeight - 8 && now.height > 1) {
          zFinal = Math.max(0.25, z * ((window.innerHeight - 8 - now.top) / now.height));
          put(zFinal);
        }
        return zFinal;
      };
      /* 数据面板先摆，拿实际生效 zoom 给结算封顶（数据面板被底部兜底压过时
         封顶偏松，结算仍可能高过数据——练习页 9566 行口径） */
      const statsZFinal = placeSide(rep, "left", baseRep.w, statsFit.z);
      const capH = statsZFinal * baseRep.h * pz;
      const zCap = baseRes.h > 1 ? capH / (baseRes.h * pz) : 2.5;
      const zResult = Math.max(0.25, Math.min(resultFit.z, zCap));
      placeSide(res, "right", baseRes.w, zResult);
    };
    requestAnimationFrame(place);
    /* 面板内容尺寸可能异步变化（雷达 React root 落地）——阶梯重测：
       Safari 布局收敛慢（22:29 张老师报「侧位明明够宽却进遮罩」），一次
       瞬态误判即锁死——多档补测让侧位/遮罩判定随布局稳定自动纠正 */
    const retries = [150, 400, 900, 1500, 2500].map((ms) => window.setTimeout(() => requestAnimationFrame(place), ms));
    document.fonts?.ready.then(() => requestAnimationFrame(place)).catch(() => {});
    /* 全屏切换/窗口变化重摆（2026-11-27 13:46 张老师报障：进原生全屏后棋盘
       布局变了（fullscreenElement 铺满视口+gwrap 重定位），place() 不重跑
       → 面板停在窗口态坐标盖住棋盘。练习页 fullscreenchange 同口径重算） */
    const repl = () => requestAnimationFrame(place);
    window.addEventListener("resize", repl);
    document.addEventListener("fullscreenchange", repl);
    return () => {
      for (const t of retries) window.clearTimeout(t);
      window.removeEventListener("resize", repl);
      document.removeEventListener("fullscreenchange", repl);
      /* 卸载：面板搬回 game_area、遮罩摘除（组件卸载时 gr_modal 一并清）。
         面板的直接父是卡片里的槽节点（#lv_grm_*），判归属用 host.contains */
      const host = modalHostRef.current;
      if (host) {
        if (host.contains(rep)) ga.appendChild(rep);
        if (host.contains(res)) ga.appendChild(res);
        rep.style.visibility = "";
        res.style.visibility = "";
        host.remove();
        modalHostRef.current = null;
      }
    };
  }, [phase, stats, zoom, level]);

  /* 滚轮缩放：受限在 .box 内（放大溢出回滚），练习页同参数 */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!settingsRef.current?.wheelZoom) return;
      e.preventDefault();
      wheelAcc.current += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      let steps = Math.trunc(wheelAcc.current / 100);
      if (steps === 0) return;
      if (Math.abs(steps) > 5) {
        steps = Math.sign(steps) * 5;
        wheelAcc.current = 0;
      } else {
        wheelAcc.current -= steps * 100;
      }
      const prevZ = zoomRef.current;
      let nz = Math.max(0.5, Math.min(2.5, prevZ - steps * 0.1));
      const gwrap = gwrapRef.current;
      const box = rootRef.current?.closest(".box") as HTMLElement | null;
      if (nz > prevZ && gwrap && box) {
        const gr = gwrap.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        const pad = 2;
        if (gr.bottom > br.bottom - pad || gr.right > br.right - pad || gr.left < br.left + pad) {
          nz = prevZ;
        }
      }
      setZoom(nz);
      zoomRef.current = nz;
      if (wheelTimer.current !== null) clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        writeZoom(levelRef.current ?? "beg", zoomRef.current);
      }, 320);
    };
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
      if (wheelTimer.current !== null) clearTimeout(wheelTimer.current);
    };
  }, []);

  /* 网页全屏形态切换（练习页 setWebFs 口径）：只管类开关，被全屏按钮/
     开关关闭路径调用——声明已上移至 feed 轮询前（stopped 分支调用） */

  /* 全屏按钮（2026-11-27 13:39 张老师定，练习页 fsBtn 同口径）：
     · 网页全屏开关关（默认）→ 走**原生独占显示器全屏**（Fullscreen API）；
     · 开关开 → 点按钮才进网页全屏（op-webfs）。
     退出对称：原生全屏中点按钮＝exitFullscreen；网页全屏中点按钮＝关形态 */
  const onFsBtn = useCallback(() => {
    const s = settingsRef.current;
    const webFsPref = s?.webFullscreen === true;
    /* 原生全屏中且宿主是本组件 → 退出原生（全屏中点按钮的默认语义） */
    if (document.fullscreenElement === rootRef.current) {
      document.exitFullscreen();
      return;
    }
    if (webFs) {
      /* 当前在网页全屏态（开关开着进来的）→ 点按钮退出网页全屏 */
      applyWebFs(false);
      return;
    }
    if (webFsPref) {
      applyWebFs(true);
      return;
    }
    /* 默认：原生独占全屏（失败静默——无手势/权限被拒等） */
    const p = rootRef.current?.requestFullscreen();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, [webFs, applyWebFs]);

  const updateSettings = useCallback((patch: Partial<LiveSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      writeSettings(next);
      settingsRef.current = next;
      if (patch.sndFb !== undefined) setReplaySndForLive(next.sndFb);
      if (patch.stats === false) {
        /* 数据统计关＝面板整体收起（任意 phase——面板现已持续可见） */
        setStats(null);
        setCountdown(null);
        lastStatsRef.current = null;
        if (phase === "ended") setPhase("waiting");
      }
      return next;
    });
    if (patch.webFullscreen === false && webFs) {
      /* 关掉开关时正处网页全屏态 → 立即退出（练习页口径：玩家找不到出口）；
         打开开关**只改按钮行为**，不立即进全屏（2026-11-27 13:39 张老师定） */
      applyWebFs(false);
    }
  }, [applyWebFs, phase, webFs]);

  const onZoomRange = useCallback((v: number) => {
    const nz = Math.max(0.5, Math.min(2.5, v));
    setZoom(nz);
    zoomRef.current = nz;
    writeZoom(levelRef.current ?? "beg", nz);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (t instanceof Element && (t.closest(".live_gsettings") || t.closest("#btn_settings"))) return;
      setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  const s = settings;
  /* 面板只在终局态显示（2026-11-27 19:06 张老师定：播放过程中统计/结算
     面板都隐藏——收回 18:39 的「持续可见」口径） */
  const statRows: [string, string, string][] | null = stats && phase === "ended"
    ? statsRows({
        t: stats.ms / 1000,
        board3bv: stats.board3bv,
        solvedBv: stats.solvedBv,
        solvedOps: stats.solvedOps,
        totalOps: stats.totalOps,
        solvedIsls: stats.solvedIsls,
        totalIsls: stats.totalIsls,
        clLeft: stats.clLeft,
        clRight: stats.clRight,
        clDouble: stats.clDouble,
        ce: stats.ce,
        pathPx: stats.path,
        crossings: stats.cp,
        flags: stats.flags,
        ln: level === "beg" ? 1 : level === "int" ? 2 : 3,
      } satisfies StatsRowSource)
    : null;
  /* 结算雷达与评级（练习页终局口径）；面板只在 ended 态显示 */
  const showEnd = phase === "ended" && !!stats;
  const radarPts = showEnd && stats ? liveRadarPoints(stats, level, false, metricDists) : null;
  const perfGrade = radarPts ? radarOverall(radarPts) : "?";
  /* 是否有待播候选（服务端决策结果，19:31 张老师定单条下发） */
  const hasPending = nextRep !== null;
  /* 下一局亮起计时的辅助 ref（见下方 effect：hover 保持/新一轮判定） */
  const prevPendingRef = useRef(false);
  const hoverHoldRef = useRef(false);
  /* ended 态下候选到达（2026-11-27 14:54 张老师报：主播打完新一局「下一局」
     亮起但没有倒计时）。口径：**按钮亮起即开始计时**——统一 N=3 秒
     （21:44 张老师定：原「短踩雷局<15% 3 秒、其余 5 秒」的两档收并，5 秒偏长）；
     hover 停过的同轮不复活，候选出现＝新一轮重启。候选可能晚于 onEnd 才到
     （服务端选局走轮询），统一在此启动倒计时 */
  useEffect(() => {
    if (phase !== "ended") { prevPendingRef.current = hasPending; return; }
    if (hasPending !== prevPendingRef.current) hoverHoldRef.current = false; /* 新一轮 */
    prevPendingRef.current = hasPending;
    if (!hasPending) return;
    if (hoverHoldRef.current) return; /* hover 保持手动 */
    if (countdown !== null) return; /* 已在计时 */
    /* 倒计时窗口规则（2026-11-27 22:29 张老师定）：上一录像放完 ≤3s 内候选
       到达 → 照常 3 秒倒计时；>3s 才到 → 不再显示倒计时直接连播（观众等了
       半天，倒计时纯属折磨） */
    const endedAt = endedAtRef.current;
    if (endedAt !== null && Date.now() - endedAt >= 3000) { void playNext(); return; }
    setCountdown(3);
  }, [phase, hasPending, countdown, playNext]);
  /* 数据统计关＝自动连播（19:31 前由 onEnd 直接触发；候选走轮询后改效果接管） */
  useEffect(() => {
    if (phase !== "ended" || !hasPending || settingsRef.current?.stats) return;
    const t = window.setTimeout(() => void playNext(), 700);
    return () => window.clearTimeout(t);
  }, [phase, hasPending, playNext]);
  const lvName = (LEVEL_NAMES as Record<string, string>)[level] ?? "";
  /* 比赛剩余时间括号（2026-11-27 21:25 张老师定）：色阶同比赛页——
     ≤10min 玫瑰红 #f92672 / ≤30min 黄 #e6c07b / 其余绿 #a6e22e；
     文案「x天x小时x分钟」；nowSec 未就绪（SSR 初帧）或心跳未带终点
     （旧心跳）不显示。归零显 0（同比赛页停表口径） */
  const compTail = (() => {
    if (!comp?.end || nowSec === null) return null;
    const remain = Math.max(comp.end - nowSec, 0);
    const d = Math.floor(remain / 86400);
    const h = Math.floor((remain % 86400) / 3600);
    const min = Math.floor((remain % 3600) / 60);
    const color = remain / 60 <= 10 ? "#f92672" : remain / 60 <= 30 ? "#e6c07b" : "#a6e22e";
    return <>（剩余<span style={{ color }}>{`${d > 0 ? `${d}天` : ""}${h}小时${min}分钟`}</span>）</>;
  })();
  const completion = stats && stats.board3bv > 0 ? stats.solvedBv / stats.board3bv : 0;
  /* 胜局（2026-11-27 13:32 张老师报障）：用引擎重放终态（ReplayStats.won）
     ——EVF 头部 won 恒 false（观看用途导出），flags 推断在自动补旗不进
     事件流的场景恒判错（完成的局显示「未完成」+ 无评级根因） */
  const won = stats ? stats.won : false;

  /* 「玩家正在对局中」绿色气泡（2026-11-27 18:39 张老师定）：主播在练但无
     录像可播（空白地图等待态）时，屏幕正中弹全站通用 toast（loading 型＝
     绿底 + 文字后转圈）；带当前局完成百分比（19:21 张老师定）。toast 有
     8s 兜底自动渐隐，7.5s 续期重推保持常驻（重推时读 progressRef 最新值）；
     起播/停止/主播离开等待态即收（cleanup toastLoadingDone） */
  const showInGameTip = !stopped && !denied && live && phase === "waiting";
  const progressRef = useRef<number | null>(null);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  const curGameIdRef = useRef<string | null>(null);
  useEffect(() => { curGameIdRef.current = curGameId; }, [curGameId]);
  const lastPlayedIdRef = useRef<string | null>(null);
  useEffect(() => { lastPlayedIdRef.current = lastPlayedId; }, [lastPlayedId]);
  useEffect(() => {
    if (!showInGameTip) return;
    const tip = () => {
      /* 等待玩家开始（22:29 张老师定）：主播停在上一局结算画面未开新局时，
         气泡文案换掉且不显示旧局进度；已开新局（局中无录像可播）才报进度 */
      const waitingNew = curGameIdRef.current !== null && curGameIdRef.current !== lastPlayedIdRef.current;
      if (!waitingNew) return "等待玩家开始";
      const p = progressRef.current;
      return p !== null ? `玩家正在对局中（已完成 ${p}%）` : "玩家正在对局中";
    };
    toastLoading(tip());
    const t = window.setInterval(() => toastLoading(tip()), 7500);
    return () => { window.clearInterval(t); toastLoadingDone(); };
  }, [showInGameTip]);

  /* 「下一局」按钮三态（2026-11-27 18:39 定 / 19:06 修）：
     · ended + 有未播录像 → 「下一局」金色可点（亮起倒计时不变）
     · 对局中（播放中，或 ended + 无未播 + 主播在练）→ 「对局中」金色降
       亮度 + 转圈禁用（播放中面板整体隐藏，按钮随面板不可见；ended 态可见）
     · 主播未开局（ended + 无未播 + !live）→ 「未开始下一局」禁用 */
  const busy = phase === "playing" || phase === "loading";
  const canNext = phase === "ended" && hasPending;
  const onDuty = busy || (phase === "ended" && live && !hasPending);
  /* 主播已开新局（22:29 张老师定）：curGameId≠最近看完的局＝新局在局中；
     相同（或主播端无 state）＝主播停在上一局结算画面——按钮「等待玩家开始」、
     不显示旧局进度残留（progress 是上一局的） */
  const newGameOn = curGameId !== null && curGameId !== lastPlayedId;
  const waitingStart = onDuty && !newGameOn;
  const nextLabel = canNext ? "下一局" : waitingStart ? "等待玩家开始" : onDuty ? "对局中" : "未开始下一局";

  /* 中途被拉黑/取消关注（2026-11-27 20:23 张老师定）：整页提示——与 SSR
     入口面板同文案「由于该玩家的隐私设置，你无法旁观」（feed 403 下发）；
     排在 stopped 引导页前——拒绝态下不显示「没有在练习」引导页 */
  if (stopped && denied) {
    return (
      <div className="op_root live_watch live_watch_stopped">
        <FlopSprites />
        <div className="live_gate">
          <div className="live_gate_title">
            <span className="live_gate_rest">{denied}</span>
          </div>
        </div>
      </div>
    );
  }

  /* 主播离开（2026-11-27 13:01 张老师定）：曾直播后转为停止——整页切换到
     「XXX没有在练习」引导页形态（与未关注引导页同版式：左上角「旁观」黄 h1、
     姓名可点进主页、军衔徽章+大字号正确配色、关注按钮（已关注态）+ 通知文案）。
     15:11 张老师定：非终态——轮询照跑，主播恢复直播自动撤回观看页 */
  if (stopped) {
    const he = host.sex ? "他" : "她";
    return (
      <div className="op_root live_watch live_watch_stopped">
        <FlopSprites />
        <div className="live_gate">
          <div className="live_gate_title">
            {host.isDefault
              ? <DefaultAvatar sex={host.sex} size="small" className="live_avatar" alt={host.name} />
              : <img className="live_avatar" src={host.avatar} alt={host.name} />}
            <Link href={`/user/${uid}`} className="live_gate_name" prefetch={false}>{host.name}</Link>
            <span className={`gender ${host.sex ? "male" : "female"}`} aria-label={host.sex ? "男" : "女"} />
            <span className="live_gate_rank">
              <RankBadge title={host.title} />
              <span className="live_gate_rank_name" style={{ color: host.titleColor }}>{host.title}</span>
            </span>
            <span className="live_gate_rest">没有在练习</span>
          </div>
          <div className="live_gate_action">
            <AvatarFollowBtn uid={uid} sex={host.sex} loggedIn following />
            <span className="live_gate_tip">{he}开始练习时，系统会自动通知你</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="op_root live_watch" ref={rootRef}>
      <FlopSprites />
      {/* 标题行：「旁观」（黄 h1）+ 副标题「YYY正在练习」（头像/中文名/性别/
          军衔徽章+称号）+ 直播红点紧靠「正在练习」右侧；右上 gicon 永远右对齐 */}
      <div className="news_head live_head">
        <h1>旁观</h1>
        <div className="live_host">
          <Link href={`/user/${uid}`} className="live_host_name" prefetch={false}>{host.name}</Link>
          {/* 英文名不再显示（2026-11-27 21:12 张老师定） */}
          <span className={`gender ${host.sex ? "male" : "female"}`} aria-label={host.sex ? "男" : "女" } />
          <span className="live_host_title">
            <RankBadge title={host.title} />
            <span style={{ color: host.titleColor }}>{host.title}</span>
          </span>
          {/* 比赛模式（2026-11-27 20:30 张老师定）：「正在练习」换「正在参加
              {比赛全称}（剩余…）」——20:54 定：前缀「正在参加」是暗灰文字不是
              链接，链接只包比赛全称（新标签详情页）；21:12 定：比赛名前加空格；
              21:25 定：比赛名后括号剩余时间，色阶同比赛页（≤10min 玫瑰红 /
              ≤30min 黄 / 其余绿）。compName 空（心跳只落了 id）＝服务端查名
              失败，退回「正在比赛」无链接 */}
          {comp
            ? (comp.name
              ? <span className="live_host_playing">
                  正在参加 <a className="live_comp_link" href={`/tournaments/${comp.id}`} target="_blank" rel="noopener">{comp.name}</a>
                  {compTail}
                </span>
              : <span className="live_host_playing">正在比赛</span>)
            : <span className="live_host_playing">正在练习</span>}
          {/* 「x人正在旁观」徽标（2026-11-27 23:38 张老师定：从主板块右下角挪回
              标题行——旁观页的结算面板浮在主板块右下，徽标放那里会被面板盖住；
              标题行在版面流内、面板盖不到）。紧跟「正在练习 / 正在参加 XXX」之后，
              外观沿用 .live_viewers_badge 圆角矩形同款；viewers=0 隐藏（观众打开
              页面即计入 ≥1 常显） */}
          {viewerCount > 0 && (
            <span className="live_viewers_badge live_watchers_badge">
              {viewerCount}人正在旁观
            </span>
          )}
        </div>
        <div className="gicons">
          <button className="gicon" id="btn_settings" type="button" onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen} aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
            </svg>
            <span className="tip">设置</span>
          </button>
          <button className={`gicon${webFs || fsNative ? " active" : ""}`} id="btn_fs" type="button"
            onClick={onFsBtn}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
            <span className="tip">全屏</span>
          </button>
        </div>
        {settingsOpen && s && (
          <div className="gsettings open live_gsettings" role="dialog" aria-label="观看设置">
            <div className="gs_row">
              <span className="gs_name">数据统计</span>
              <label className="gsw"><input type="checkbox" checked={s.stats} onChange={(e) => updateSettings({ stats: e.target.checked })} /><span className="track" /></label>
              <span className="tip">录像播放结束后显示数据统计与结算面板</span>
            </div>
            <div className="gs_row">
              <span className="gs_name">声音反馈</span>
              <label className="gsw"><input type="checkbox" checked={s.sndFb} onChange={(e) => updateSettings({ sndFb: e.target.checked })} /><span className="track" /></label>
              <span className="tip">开空、标雷时播放声音反馈</span>
            </div>
            <div className="gs_row">
              <span className="gs_name">像素风格</span>
              <label className="gsw"><input type="checkbox" checked={s.pixelStyle} onChange={(e) => updateSettings({ pixelStyle: e.target.checked })} /><span className="track" /></label>
              <span className="tip">使用像素风格对数字进行渲染</span>
            </div>
            <div className="gs_row">
              <span className="gs_name">网页全屏</span>
              <label className="gsw"><input type="checkbox" checked={s.webFullscreen} onChange={(e) => updateSettings({ webFullscreen: e.target.checked })} /><span className="track" /></label>
              <span className="tip">全屏模式只在页面内最大化游戏界面，不独占屏幕</span>
            </div>
            <div className="gs_row">
              <span className="gs_name">滚轮缩放</span>
              <label className="gsw"><input type="checkbox" checked={s.wheelZoom} onChange={(e) => updateSettings({ wheelZoom: e.target.checked })} /><span className="track" /></label>
              <span className="tip">鼠标滚轮可调整显示比例</span>
            </div>
            <div className="gs_zoom">
              <span className="zlabel">显示比例</span>
              <input type="range" min="0.5" max="2.5" step="0.05" value={zoom}
                onChange={(e) => onZoomRange(parseFloat(e.target.value))} />
              <span className="zval">{zoom.toFixed(2)}x</span>
            </div>
          </div>
        )}
      </div>

      {/* 游戏窗：练习页同款 game_area；终局面板悬浮在 gwrap 两侧（不挤占空间） */}
      <div className="live_game" id="game_area" ref={gameAreaRef}>
        <div className="gwrap" ref={gwrapRef}>
          <div className="gbar">
            <svg className="ledc" ref={ledMinesRef} viewBox="0 0 410 250" role="img" aria-label="剩余雷数">
              <use href="#top-counters" />
              <use className="d" href="#count-0" x="20" y="20" />
              <use className="d" href="#count-0" x="150" y="20" />
              <use className="d" href="#count-0" x="280" y="20" />
            </svg>
            <button className="face" type="button" aria-label="表情">
              <svg viewBox="0 0 260 260" width="26" height="26"><use ref={faceUseRef} href="#face-normal" /></svg>
            </button>
            <svg className="ledc" ref={ledTimeRef} viewBox="0 0 410 250" role="img" aria-label="计时">
              <use href="#top-counters" />
              <use className="d" href="#count-0" x="20" y="20" />
              <use className="d" href="#count-0" x="150" y="20" />
              <use className="d" href="#count-0" x="280" y="20" />
            </svg>
          </div>
          <div className="gframe">
            <div className="gboard_wrap">
              <div className="board size16 game" ref={wrapRef}>
                <div ref={boardRef}>
                  <Board id={`live_${uid}`} level={level} board={seed} size={16} vec />
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* 左：数据统计面板（练习页 .greport 同款悬浮；仅 ended 态显示） */}
        <div className={`greport live_report${showEnd && statRows ? " show" : ""}`} ref={reportRef}>
          {statRows && (
            <table cellPadding={0} cellSpacing={0}>
              <tbody>
                {statRows.map(([k, v, tip]) => (
                  <tr key={k} title={tip}>
                    <td>{k}</td>
                    <td className="gv">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* 右：结算面板（练习页 .gresult 同款悬浮：标题评级 + 雷达 + 下一局按钮；
            仅 ended 态显示——播放中隐藏，19:06 张老师定） */}
        <div className={`gresult live_result${showEnd && stats ? " show" : ""}`} ref={resultRef}>
          {showEnd && stats && (
            <>
              <div className="gr_title">
                <span className={`gr_lv${won ? "" : " fail"}`}>
                  {won
                    ? <>{lvName}<em className={`lv_${level}`}>{(stats.ms / 1000).toFixed(3)}</em>秒</>
                    : <>未完成{stats.solvedBv > 0
                      ? <span className="est">(预计 {((stats.ms / 1000) * (stats.board3bv / stats.solvedBv)).toFixed(2)}秒)</span>
                      : null}</>}
                </span>
                <span className="gr_rate">评级：<b style={{ color: gradeColor(perfGrade) }}>{perfGrade === "?" ? "—" : perfGrade}</b></span>
              </div>
              <div className="gr_radar">
                {radarPts && <VideoAnalysisRadar data={radarPts} fill />}
              </div>
              {/* 下一局按钮三态（18:39/19:06 张老师定）：下一局（金色可点+
                  倒计时）/ 对局中（金降亮度+转圈禁用）/ 未开始下一局（灰禁用） */}
              <button
                type="button"
                className={`grb grb_new_game${canNext || onDuty ? " grb_gold" : ""}${onDuty ? " grb_dim" : ""}`}
                disabled={!canNext}
                onMouseEnter={() => onNextHover(true)}
                onMouseLeave={() => onNextHover(false)}
                onClick={() => { if (canNext) onNextClick(); }}
              >
                {/* 文字包 grb_txt：转圈图标 absolute 锚其右缘（20:54 张老师定）
                    ——图标不占 flex 流宽，「对局中」文字与无图标时完全同位居中 */}
                <span className="grb_txt">
                  {nextLabel}
                  {/* 进度只随「主播已开新局」显示（22:29 张老师定）——waitingStart
                      （主播停在上一局结算画面）时 progress 是旧局残留，不显示 */}
                  {!canNext && onDuty && newGameOn && progress !== null ? `(${progress}%)` : ""}
                  {canNext && countdown !== null && countdown > 0 ? `(${countdown})` : ""}
                  {onDuty && <span className="grb_spin" aria-hidden="true" />}
                </span>
              </button>
            </>
          )}
        </div>
        {/* 底部状态行（「画面同步中…」等）已撤（2026-11-27 15:15 张老师定：
            该文案位置去掉——观看页底部不再显示状态字；连接异常静默重试） */}
      </div>
    </div>
  );
}
