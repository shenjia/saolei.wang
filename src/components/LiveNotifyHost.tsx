"use client";

// 粉丝端「正在练习」通知气泡（2026-11-27 张老师需求；23:48 改版多条堆叠）：
// 关注的玩家开「允许旁观」并玩完一盘（含踩雷局）后，在线粉丝页面右下角弹出
// 悬浮小气泡「XXX正在练习」（姓名/性别/军衔正确渲染）；下沿深灰小字
// 「点击去旁观」，点击在新标签页打开旁观界面。
//
// 去重（页面级·按旁观场次，2026-11-27 13:50 张老师定）：
// · 单一页面生命周期内，每个玩家的**同一场练习**只弹一次；
// · 玩家停止（离线）后再开（下一场），会再次提醒（离开时清除该玩家的
//   「本场已弹」标记）；
// · 点击去旁观≠永久屏蔽（旧 localStorage 永久口径已废）——点过的这场上
//   不再弹，下一场照常提醒；
// · 多玩家同播：最多同时显示 3 条，每条都可独立点击；更多候选排队，
//   每 4 秒整体向上滚动一格，最上方条目继续上移并渐隐，新条目从底部进入。
//
// 轮询：60s /api/watch/notify（登录粉丝视角）。观察流：每次轮询记录在线集合，
// 离开的玩家清「已弹」标记——再上线就是新一场。
// 气泡形态：右下 fixed 卡片堆，15s 自动淡出；悬停任一条时整堆暂停计时。

import { useCallback, useEffect, useRef, useState } from "react";
import { DefaultAvatar } from "@/components/DefaultAvatar";
import { RankBadge } from "@/components/RankBadge";
import { sfxPlay, sfxPrefetch } from "@/lib/sfx";

/* 弹出提示音（2026-11-27 20:20 张老师定）：气泡显示时播放 Steam 成就提示音。
   复用站内 sfx 播放器（Web Audio 优先、HTMLAudio 兜底；用户无手势的会话
   浏览器 autoplay 策略会拦——sfx 内部 catch 静默，点过页面即解锁）。 */
const NOTIFY_SND = "/sounds/live-notify.mp3";

/* 排行局反作弊自家节点注册表：通知在结算后动态挂载，OnlinePlay 武装时的
   一次性注册扑空；由这里按真实 DOM 对象入册，绝不按可仿冒的 class 放行。 */
const liveNotifyNodes = new WeakSet<Element>();
export function isRegisteredLiveNotify(el: Element): boolean {
  return liveNotifyNodes.has(el);
}

interface NotifyStreamer {
  uid: number;
  name: string;
  sex: number;
  title: string;
  titleColor: string;
  avatar: string;
  isDefault: boolean;
  /** 当前旁观人数（>0 时 hint 行显示「x人正在旁观」，否则「点击去旁观」） */
  viewers: number;
  /** 比赛模式（2026-11-27 20:30 张老师定）：真＝「正在练习」换「正在比赛」 */
  comp: boolean;
}

interface NotifyCard {
  streamer: NotifyStreamer;
  /** 退场卡片保留 250/300ms 做动画，不再响应鼠标 */
  leaving: boolean;
  /** 队列轮换：最上方卡片额外向上挪一格；普通点击/超时只原地淡出 */
  cycle: boolean;
  /** 0=最下方，2=三格堆叠的最上方；3 仅供轮换退场使用 */
  slot: number;
}

const POLL_MS = 60_000;
const SHOW_MS = 15_000; /* 无后续排队时，每条停留 15 秒；悬停整堆暂停 */
const ROTATE_MS = 4_000; /* 还有更多候选时，每 4 秒向上滚动一格 */
const EXIT_MS = 300;
const MAX_VISIBLE = 3;
const NOTIFY_STEP = 74; /* 卡片 64px + 间距 10px，与 globals.css 保持一致 */

/* 自己正在练习页对局中（2026-11-27 14:12 张老师定：游戏进行中不打扰）：
 * 在 /online（#online_play 存在）且未到结算态（gresult 未显示、gr_modal
 * 遮罩未开）＝局中/开局间歇。通知此时只入队不弹出；游戏结束（结算面板
 * 显形）后下一拍消费。结算态判定与练习页 revealResultPanels/enterMask
 * 同口径（.gresult.show / #gr_modal 非 hidden）。 */
function isSelfPlaying(): boolean {
  const play = document.querySelector("#online_play");
  if (!play) return false; /* 不在练习页 */
  const ended = play.querySelector(".gresult.show")
    || (document.querySelector("#gr_modal") as HTMLElement | null)?.hidden === false;
  return !ended;
}

/* 「我此刻正在旁观谁」（2026-11-28 张老师报「旁观 A 时还弹 A 正在练习」）：
   原 watchingUidNow 的路径匹配只认旧路由 /live/，旁观页改名 /watch/ 后恒返回
   0 → 下方 s.uid !== watchingUid 的过滤形同虚设。现两种前缀都认（/live/ 是
   301 跳转前的瞬时态及站内可能残留的旧链接）；非旁观页返回 0（＝不过滤）。
   提成模块级纯函数，供轮询过滤、pump 入场闸、路由切换即时收卡三处共用同一
   判定，禁止单边漂移 */
function watchingUidOf(pathname: string): number {
  const m = pathname.match(/^\/(?:watch|live)\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/* 活跃卡片按「 oldest 在上、最新在下」分配固定槽位。轮换退场卡不占槽，
   因而旧顶部向第 4 格离场时，其余卡片与新卡片能同拍向上补位。 */
function layoutCards(cards: NotifyCard[]): NotifyCard[] {
  let slot = cards.filter((c) => !c.leaving).length - 1;
  return cards.map((card) => {
    if (card.leaving) return card;
    const placed = { ...card, slot };
    slot -= 1;
    return placed;
  });
}

interface NotifyCardViewProps {
  card: NotifyCard;
  paused: boolean;
  onExpire: (uid: number) => void;
  onOpen: (streamer: NotifyStreamer) => void;
  onMute: (streamer: NotifyStreamer) => void;
  onHover: (uid: number | null) => void;
}

function LiveNotifyCard({ card, paused, onExpire, onOpen, onMute, onHover }: NotifyCardViewProps) {
  const s = card.streamer;

  /* 每张卡独立计时；slot 变化只驱动位移，不重置 15 秒停留时间。
     悬停整堆暂停，离开后重计 15 秒（沿用旧单条气泡口径）。 */
  useEffect(() => {
    if (card.leaving || paused) return;
    const timer = window.setTimeout(() => onExpire(s.uid), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [card.leaving, paused, s.uid, onExpire]);

  return (
    <div
      className={`live_notify${card.leaving ? " closing" : ""}${card.cycle ? " cycling" : ""}`}
      style={{ bottom: card.slot * NOTIFY_STEP }}
      role="status"
      onMouseEnter={() => onHover(s.uid)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onOpen(s)}
    >
      <div className="live_notify_main">
        {s.isDefault
          ? <DefaultAvatar sex={s.sex} size="small" className="live_notify_avatar" alt={s.name} />
          : /* eslint-disable-next-line @next/next/no-img-element */
            <img className="live_notify_avatar" src={s.avatar} alt={s.name} />}
        <span className="live_notify_name">{s.name}</span>
        <span className={`gender ${s.sex ? "male" : "female"}`} aria-label={s.sex ? "男" : "女"} />
        <span className="live_notify_rank">
          <RankBadge title={s.title} />
          <span className="live_notify_rank_name" style={{ color: s.titleColor }}>{s.title}</span>
        </span>
        <span className="live_notify_playing">{s.comp ? "正在比赛" : "正在练习"}</span>
        <span className="live_notify_dot" aria-hidden="true" />
      </div>
      <p className="live_notify_hint">
        <span className="live_notify_go">
          {s.viewers > 0 ? `${s.viewers}人正在旁观` : "点击去旁观"}
        </span>
        <a
          href="#"
          className="live_notify_mute"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMute(s);
          }}
        >今日不再提醒</a>
      </p>
    </div>
  );
}

export function LiveNotifyHost() {
  const [cards, setCards] = useState<NotifyCard[]>([]);
  const cardsRef = useRef<NotifyCard[]>([]);
  const [queueLen, setQueueLen] = useState(0);
  const queueRef = useRef<NotifyStreamer[]>([]);
  const [hoveringUid, setHoveringUid] = useState<number | null>(null);
  const hoveringUidRef = useRef<number | null>(null);
  const nextRotateAtRef = useRef(0);
  /* 局中挂起时的观察器句柄（结算出现即清） */
  const playingWatchRef = useRef<number | null>(null);
  const closeTimersRef = useRef<Map<number, number>>(new Map());
  /* 本页面周期内「这场练习已弹过」的玩家集合；玩家离线即摘除（再上线=新一场） */
  const notifiedRef = useRef<Set<number>>(new Set());

  const commitCards = useCallback((next: NotifyCard[]) => {
    cardsRef.current = next;
    setCards(next);
  }, []);

  /* 有空位就立即补入，最多三条。普通点击退场的卡片仍占原槽直到动画结束，
     避免补位卡与渐隐卡重叠；轮换退场卡例外，立刻让出新底部槽位。 */
  const pump = useCallback(() => {
    if (isSelfPlaying()) return;
    /* 入场闸（2026-11-28）：正在旁观的玩家不弹——过滤只发生在 60s 轮询拍，
       轮询间隔内入队的残留（或路由刚切换）不能在这一拍被放出来 */
    const watching = watchingUidOf(location.pathname);
    if (watching) queueRef.current = queueRef.current.filter((q) => q.uid !== watching);
    const occupied = cardsRef.current.filter((c) => !c.leaving || !c.cycle).length;
    const capacity = MAX_VISIBLE - occupied;
    if (capacity <= 0 || !queueRef.current.length) return;
    const additions = queueRef.current.splice(0, capacity).map((streamer) => ({
      streamer,
      leaving: false,
      cycle: false,
      slot: 0,
    }));
    setQueueLen(queueRef.current.length);
    commitCards(layoutCards([...cardsRef.current, ...additions]));
  }, [commitCards]);

  /* 统一退场：点击/免打扰/15s 到点原地渐隐；队列轮换则顶部继续上移。
     每卡独立关闭定时器，多条同时操作互不阻塞。 */
  const dismiss = useCallback((uid: number, cycle = false) => {
    const target = cardsRef.current.find((c) => c.streamer.uid === uid && !c.leaving);
    if (!target) return;
    if (hoveringUidRef.current === uid) {
      hoveringUidRef.current = null;
      setHoveringUid(null);
    }
    let next = cardsRef.current.map((card) => card.streamer.uid === uid
      ? { ...card, leaving: true, cycle, slot: cycle ? MAX_VISIBLE : card.slot }
      : card);
    if (cycle) next = layoutCards(next);
    commitCards(next);
    if (cycle) pump(); /* 顶部离场的同一拍，新卡从底部补入 */

    const oldTimer = closeTimersRef.current.get(uid);
    if (oldTimer !== undefined) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => {
      closeTimersRef.current.delete(uid);
      commitCards(layoutCards(cardsRef.current.filter((c) => c.streamer.uid !== uid)));
      pump();
    }, EXIT_MS);
    closeTimersRef.current.set(uid, timer);
  }, [commitCards, pump]);

  /* 队列轮换：仅在三格占满且确有后续时运行。独立调度器直接读 ref，
     不受父级重渲染影响；悬停任意卡片则清零倒计时，离开后重新等待 4 秒。 */
  const activeCards = cards.filter((c) => !c.leaving);
  const activeKey = activeCards.map((c) => c.streamer.uid).join(",");
  useEffect(() => {
    const timer = window.setInterval(() => {
      const active = cardsRef.current.filter((c) => !c.leaving);
      if (!queueRef.current.length || hoveringUidRef.current !== null || active.length < MAX_VISIBLE) {
        nextRotateAtRef.current = 0;
        return;
      }
      const now = Date.now();
      if (!nextRotateAtRef.current) {
        nextRotateAtRef.current = now + ROTATE_MS;
        return;
      }
      if (now < nextRotateAtRef.current) return;
      nextRotateAtRef.current = 0;
      dismiss(active[0].streamer.uid, true);
    }, 250);
    return () => window.clearInterval(timer);
  }, [dismiss]);

  /* 自己局中只入队不显示；结算出现后 1s 观察拍补位。 */
  useEffect(() => {
    if (queueLen === 0 || activeCards.length >= MAX_VISIBLE || !isSelfPlaying()) return;
    if (playingWatchRef.current !== null) return;
    playingWatchRef.current = window.setInterval(() => {
      if (isSelfPlaying()) return;
      if (playingWatchRef.current !== null) {
        window.clearInterval(playingWatchRef.current);
        playingWatchRef.current = null;
      }
      pump();
    }, 1000);
  }, [activeCards.length, queueLen, pump]);

  /* 轮询：观察在线集合 → 场次变化检测 → 入队并立即填充空位。 */
  useEffect(() => {
    let alive = true;
    const muted = (uid: number): boolean => {
      try {
        const until = Number(localStorage.getItem(`live_notify_muted_until_${uid}`) ?? "0");
        return until > Date.now();
      } catch { return false; }
    };
    const watchingUidNow = (): number => watchingUidOf(location.pathname);
    const poll = async () => {
      const watchingUid = watchingUidNow();
      try {
        const r = await fetch("/api/watch/notify", { cache: "no-store" });
        if (!alive || !r.ok) return;
        const j = await r.json() as { ok: boolean; streamers: NotifyStreamer[] };
        if (!alive || !j.ok) return;
        const online = (j.streamers ?? []).filter((s) => !muted(s.uid) && s.uid !== watchingUid);
        const onlineSet = new Set(online.map((s) => s.uid));
        for (const uid of Array.from(notifiedRef.current)) {
          if (!onlineSet.has(uid)) notifiedRef.current.delete(uid);
        }
        let queued = false;
        for (const s of online) {
          if (notifiedRef.current.has(s.uid)) continue;
          if (queueRef.current.some((q) => q.uid === s.uid)) continue;
          if (cardsRef.current.some((c) => c.streamer.uid === s.uid)) continue;
          notifiedRef.current.add(s.uid);
          queueRef.current.push(s);
          queued = true;
        }
        if (queued) {
          setQueueLen(queueRef.current.length);
          pump();
        }
      } catch { /* 静默：通知是增强链路 */ }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [pump]);

  /* 站内切到旁观页（同标签软导航进 /watch/<uid>）时立即收掉被旁观玩家的卡片与
     队列项——不能等下一个 60s 轮询拍。popstate 覆盖浏览器前进/后退；App Router
     的 <Link> 软导航不触发 popstate，用 1s 轻量轮询 pathname 兜底（仅比对字符串，
     未变化即 return，开销可忽略）。 */
  useEffect(() => {
    let last = location.pathname;
    const sweep = () => {
      if (location.pathname === last) return;
      last = location.pathname;
      const w = watchingUidOf(location.pathname);
      if (!w) return;
      queueRef.current = queueRef.current.filter((q) => q.uid !== w);
      setQueueLen(queueRef.current.length);
      if (cardsRef.current.some((c) => c.streamer.uid === w && !c.leaving)) dismiss(w);
    };
    window.addEventListener("popstate", sweep);
    const t = window.setInterval(sweep, 1000);
    return () => { window.removeEventListener("popstate", sweep); window.clearInterval(t); };
  }, [dismiss]);

  /* 提示音预取；同一批多张只响一次，后续从队列补入的新玩家再响。 */
  useEffect(() => { sfxPrefetch([NOTIFY_SND]); }, []);
  const soundedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const current = new Set(activeKey ? activeKey.split(",").map(Number) : []);
    if (Array.from(current).some((uid) => !soundedRef.current.has(uid))) sfxPlay(NOTIFY_SND);
    soundedRef.current = current;
  }, [activeKey]);

  /* 点击：新标签打开旁观；今日不再提醒：该玩家 24h 内不再弹。 */
  const openWatch = useCallback((s: NotifyStreamer) => {
    window.open(`/watch/${s.uid}`, "_blank", "noopener");
    dismiss(s.uid);
  }, [dismiss]);
  const mute = useCallback((s: NotifyStreamer) => {
    try {
      localStorage.setItem(`live_notify_muted_until_${s.uid}`, String(Date.now() + 24 * 3600 * 1000));
    } catch { /* 隐私模式 */ }
    dismiss(s.uid);
  }, [dismiss]);
  const changeHover = useCallback((uid: number | null) => {
    hoveringUidRef.current = uid;
    setHoveringUid(uid);
  }, []);

  useEffect(() => () => {
    if (playingWatchRef.current !== null) window.clearInterval(playingWatchRef.current);
    for (const timer of closeTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  if (!cards.length) return null;
  return (
    <div
      className="live_notify_stack"
      ref={(el) => { if (el) liveNotifyNodes.add(el); }}
      aria-live="polite"
      aria-relevant="additions"
    >
      {cards.map((card) => (
        <LiveNotifyCard
          key={card.streamer.uid}
          card={card}
          paused={hoveringUid !== null}
          onExpire={dismiss}
          onOpen={openWatch}
          onMute={mute}
          onHover={changeHover}
        />
      ))}
    </div>
  );
}
