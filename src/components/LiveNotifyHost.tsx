"use client";

// 粉丝端「正在练习」通知气泡（2026-11-27 张老师需求；13:50 重定去重口径）：
// 关注的主播开「允许旁观」并玩完一盘（含踩雷局）后，在线粉丝页面右下角弹出
// 悬浮小气泡「XXX正在练习」（姓名/性别/军衔正确渲染）；下沿深灰小字
// 「点击去旁观」，点击在新标签页打开旁观界面。
//
// 去重（页面级·按直播场次，2026-11-27 13:50 张老师定）：
// · 单一页面生命周期内，每个主播的**同一场直播**只弹一次；
// · 主播停止（离线）后再开（下一场），会再次提醒（离开时清除该主播的
//   「本场已弹」标记）；
// · 点击去旁观≠永久屏蔽（旧 localStorage 永久口径已废）——点过的这场上
//   不再弹，下一场照常提醒；
// · 多主播同播排队：一个显示完（淡出/点击）再弹下一个，逐个轮到。
//
// 轮询：60s /api/live/notify（登录粉丝视角）。观察流：每次轮询记录在线集合，
// 离开的主播清「已弹」标记——再上线就是新一场。
// 气泡形态：右下 fixed 卡片，15s 自动淡出（hover 暂停），点击新标签旁观。

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

const POLL_MS = 60_000;
const SHOW_MS = 15_000; /* 气泡停留：15 秒后自动淡出（hover 悬停不打断） */

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

export function LiveNotifyHost() {
  const [current, setCurrent] = useState<NotifyStreamer | null>(null);
  const [hovering, setHovering] = useState(false);
  /* 队列长度镜像（state 化——入队时驱动消费 effect；ref 队列本体） */
  const [queueLen, setQueueLen] = useState(0);
  /* 渐隐退场中（2026-11-27 14:46 张老师定）：消失先淡出 250ms 再卸载 */
  const [closing, setClosing] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  /* 局中挂起时的观察器句柄（结算出现即清） */
  const playingWatchRef = useRef<number | null>(null);
  /* 本页面周期内「这场直播已弹过」的主播集合；主播离线即摘除（再上线=新一场） */
  const notifiedRef = useRef<Set<number>>(new Set());
  /* 弹出中队列（张老师 13:50 定：一个显示完再弹下一个） */
  const queueRef = useRef<NotifyStreamer[]>([]);

  /* 统一退场（渐隐 250ms 后卸载）：15s 到点 / 点击去旁观 / 今日不再提醒
     三路共用；期间 hover 不复活（closing 态到点即走） */
  const dismiss = useCallback(() => {
    if (closeTimerRef.current !== null) return; /* 已在退场 */
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setClosing(false);
      setCurrent(null);
    }, 250);
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => dismiss(), SHOW_MS);
  }, [dismiss]);

  /* 队列驱动：气泡消失（淡出/点击）后立即取下一个候选。
     免打扰（2026-11-27 14:12 张老师定）：自己在练习局中（isSelfPlaying）
     时挂起不弹——结算态出现后 1s 拍消费（局中观察器 pollWatching） */
  useEffect(() => {
    if (current) return;
    if (!queueRef.current.length) return;
    if (isSelfPlaying()) {
      /* 局中挂起：起 1s 观察器等结算（游戏结束）再消费 */
      if (playingWatchRef.current === null) {
        playingWatchRef.current = window.setInterval(() => {
          if (isSelfPlaying()) return;
          if (playingWatchRef.current !== null) {
            clearInterval(playingWatchRef.current);
            playingWatchRef.current = null;
          }
          const next = queueRef.current.shift();
          if (next) {
            setQueueLen(queueRef.current.length);
            setCurrent(next);
          }
        }, 1000);
      }
      return;
    }
    const next = queueRef.current.shift()!;
    setQueueLen(queueRef.current.length);
    setCurrent(next);
  }, [current, queueLen]);

  /* 轮询：观察在线集合 → 场次变化检测 → 入队（入队即更新 queueLen 驱动消费） */
  useEffect(() => {
    let alive = true;
    /* 「今日不再提醒」（2026-11-27 14:16 张老师定）：该玩家 24h 内不再弹 */
    const muted = (uid: number): boolean => {
      try {
        const until = Number(localStorage.getItem(`live_notify_muted_until_${uid}`) ?? "0");
        return until > Date.now();
      } catch { return false; }
    };
    /* 正在旁观的主播不再弹（2026-11-27 14:44 张老师报：进入旁观页后还弹
       该玩家的提醒）——气泡点击新标签打开 /live/<uid>，旁观页自己是新页面
       周期（notifiedRef 为空），首次轮询就会再弹同一主播。口径：当前页
       pathname 是 /live/<uid> 时，该主播的通知一律不入队（其余主播照常，
       多主播排队不受影响）；每次轮询现算 pathname——SPA 客户端导航进入
       旁观页同样生效 */
    const watchingUidNow = (): number => {
      const m = location.pathname.match(/^\/live\/(\d+)/);
      return m ? Number(m[1]) : 0;
    };
    const poll = async () => {
      const watchingUid = watchingUidNow();
      try {
        const r = await fetch("/api/live/notify", { cache: "no-store" });
        if (!alive || !r.ok) return;
        const j = await r.json() as { ok: boolean; streamers: NotifyStreamer[] };
        if (!alive || !j.ok) return;
        const online = (j.streamers ?? []).filter((s) => !muted(s.uid) && s.uid !== watchingUid);
        const onlineSet = new Set(online.map((s) => s.uid));
        /* 离线的主播：摘「本场已弹」标记——再上线就是新一场（会再弹） */
        for (const uid of Array.from(notifiedRef.current)) {
          if (!onlineSet.has(uid)) notifiedRef.current.delete(uid);
        }
        /* 新开播且本场未弹过的主播入队（同一主播队内/正在展示不重复） */
        let queued = false;
        for (const s of online) {
          if (notifiedRef.current.has(s.uid)) continue;
          if (queueRef.current.some((q) => q.uid === s.uid)) continue;
          if (currentUidRef.current === s.uid) continue;
          notifiedRef.current.add(s.uid); /* 入队即计「已弹」（防重复入队） */
          queueRef.current.push(s);
          queued = true;
        }
        if (queued) setQueueLen(queueRef.current.length); /* 驱动消费 effect */
      } catch { /* 静默：通知是增强链路 */ }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  const currentUidRef = useRef<number | null>(null);
  useEffect(() => { currentUidRef.current = current?.uid ?? null; }, [current]);

  /* 提示音 + 预取：挂载即注册预取清单（手势解锁后自动 fetch+decode 就绪）；
     气泡显示（current 非空）时播放——局中挂起/直接消费两路统一在这触发 */
  useEffect(() => {
    sfxPrefetch([NOTIFY_SND]);
  }, []);
  useEffect(() => {
    if (current) sfxPlay(NOTIFY_SND);
  }, [current]);

  /* 停留计时：出现后 15s 淡出；hover 悬停暂停（离开重计时） */
  useEffect(() => {
    if (!current) return;
    if (!hovering) scheduleHide();
    else if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    return () => {
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [current, hovering, scheduleHide]);

  /* 点击：新标签打开旁观 → 气泡渐隐收起（本场上不再弹；下一场照常提醒） */
  const openWatch = useCallback((s: NotifyStreamer) => {
    window.open(`/live/${s.uid}`, "_blank", "noopener");
    dismiss();
  }, [dismiss]);

  if (!current) return null;
  const s = current;
  return (
    <div
      className={`live_notify${closing ? " closing" : ""}`}
      ref={(el) => { if (el) liveNotifyNodes.add(el); }}
      role="status"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => openWatch(s)}
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
        {/* 比赛模式（2026-11-27 20:30 张老师定）：「正在练习」换「正在比赛」 */}
        <span className="live_notify_playing">{s.comp ? "正在比赛" : "正在练习"}</span>
        <span className="live_notify_dot" aria-hidden="true" />
      </div>
      <p className="live_notify_hint">
        {/* 旁观数（2026-11-27 14:46 张老师定）：>0 显示「x人正在旁观」——
            一段完整文本不分割、数字同深灰；否则「点击去旁观」；
            hover 卡片主体时变绿（.live_notify:hover 联动，14:33 张老师定）；
            21:28 定：hover「今日不再提醒」时本段压回深灰（:has 联动，
            不应两个同时绿）——故包 span 供 CSS 单独选中 */}
        <span className="live_notify_go">
          {s.viewers > 0 ? `${s.viewers}人正在旁观` : "点击去旁观"}
        </span>
        {/* 「今日不再提醒」（同 14:33 张老师定）：与左侧文案同行居右，
            hover 链接变玫瑰红（.live_notify_mute:hover） */}
        <a
          href="#"
          className="live_notify_mute"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              localStorage.setItem(`live_notify_muted_until_${s.uid}`, String(Date.now() + 24 * 3600 * 1000));
            } catch { /* 隐私模式 */ }
            dismiss();
          }}
        >今日不再提醒</a>
      </p>
    </div>
  );
}
