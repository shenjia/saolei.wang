"use client";

// PK 页对战舞台（2026-11-10 张老师第六轮定）：
//   赛前：只显示左右玩家面板（向中间收拢 35%）+ VS 图标 + 图标「上方」的战前预估评价
//         （按双方总 STNB 差距分档着色：占优绿 / 不利玫瑰红 / 势均力敌金）+ 图标「下方」的
//         黄色「决出胜负」按钮；不显示数字、胜败字，也不显示下面任何板块。
//   点击按钮 → 按钮渐变消失、战前评价渐隐、两侧面板分别向左右滑回原位（650ms）
//         → 滑完才开始跑分。
//   跑分：两分数从 0.00 起、同为亮灰，固定速度 2s 涨到「败方分数」；败方停住，
//         胜方变金，再用 1s 涨到自己的最终分数（张老师 18:12 定：2s + 1s = 3s）。
//         **播放一次** /sounds/vs-rise.mp3（张老师 19:07 指定 Desktop/泡/数字.mp3，2.15s），
//         不循环；音短于 3s 动画，末尾约 0.85s 是静默段。
//   赛后：「胜」「败」两字同时渐变出现；图标下方换成亮灰赛后评价（再下移 25px）；
//         下面各板块淡入出现；并播放结算音。平局：两边 2s 同步涨完，不变金、不显字、不播结算音。
//   赛后自动截屏（2026-11-11 张老师需求）：跑分完成后把 960 内容列（#page +
//         顶部 header 条带站名 logo）截成 PNG 复制到剪贴板，绿色气泡「已截图并
//         复制到剪贴板」；声音开＝跑分结束 3s 后播截屏音（capture.mp3，在线练习
//         同款）+ 出气泡，声音关＝1s 后直接出气泡（03:26 张老师定，不等声音放完）。
//
// 下方板块是服务端渲染的 RSC，作为 below prop 传进本客户端组件，由 phase 控制挂载，
// 因此首帧（含 SSR）的可见 DOM 里完全没有它们。
// 音效：从「决出胜负」点击后才播放，天然带用户手势，不受浏览器自动播放策略限制；
// 极严策略下结算音若仍被拦，任意点击页面补播（界面不新增任何元素）。

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toCanvas } from "html-to-image";
import { toast } from "./Toast";
import { VsPickArena, type VsPickPlayer } from "./VsPick";
import { VsHistBlock } from "./VsHistBlock";
import type { VsHistRow } from "@/lib/vs";

/** 第一阶段：两边同色同速，涨到败方分数（张老师 18:12：2s） */
const CLIMB_MS = 2000;
/** 第二阶段：胜方变金后涨到自己的分数（张老师 18:12：由 2s 改为 1s） */
const SURGE_MS = 1000;
/** 两侧面板滑回原位时长；滑完才 setPhase("running")（张老师：先滑开再跑分）。
 *  按钮/战前评价的 0.4s 渐隐由 CSS transition 负责（.vs_fight_out / .vs_pre_out）。 */
const SPREAD_MS = 650;

/** 音效版本串：换音频内容必递增（沿用站内 UploadForm/OnlinePlay 惯例） */
const SND_VER = "7";
/** 数字滚动音：张老师 19:07 指定 Desktop/泡/数字.mp3（2.15s，mean -28.5dB / max -16.9dB），
 *  **不循环**（18:12 已明确去掉 loop），音量取满 1.0 补偿偏轻的响度 */
const RISE_SOUND = "/sounds/vs-rise.mp3";
/** 我方胜利：庆祝胜利 */
const WIN_SOUND = "/sounds/vs-victory.mp3";
/** 我方失败（2026-11-10 18:00 张老师「明明输了为什么还放胜利音乐」）：
 *  16:49 那条指令里胜/败两条都贴了同一个「庆祝胜利」文件，属笔误；19:07 定稿为
 *  Desktop/泡/失败.mp3（5.58s，mean -23.2dB / max -9.9dB），与胜利音各一首 */
const LOSE_SOUND = "/sounds/vs-lose.mp3";

const RISE_VOLUME = 1;
const RESULT_VOLUME = 0.6;
/** hover 音效（2026-11-11 14:38 张老师指定，btn_hover 素材 0.37s）：悬停纪录行
 *  或 BV 格时播放一次短促音；音效开关关时不播 */
const HOVER_SOUND = "/sounds/vs-hover.mp3";
const HOVER_VOLUME = 0.6;

/** 等待赛后渐显元素全部到位（.vs_below / 胜败字 opacity→1），1.5s 兜底防卡死 */
function waitSettled(): Promise<void> {
  return new Promise<void>((res) => {
    const t0 = Date.now();
    const tick = () => {
      const els = [
        document.querySelector(".vs_below"),
        ...Array.from(document.querySelectorAll(".vs_mark")),
      ];
      const settled =
        els.every((e) => e && parseFloat(getComputedStyle(e).opacity) >= 1) &&
        els.length > 0;
      if (settled || Date.now() - t0 > 1500) return res();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * 生成整页截图 PNG Blob（2026-11-11 张老师需求；桌面自动截屏与移动端
 * 「保存到相册」共用）：#page 全内容（英雄区→纪录→BV 三板块→底部说明从头到尾）
 * + 顶部 #header .wrapper（站名 logo 条；移动端 #header display:none 时跳过），
 * 左右各 40 逻辑 px 留白、body 底色铺满（03:29/03:39 张老师定）。
 * filter 剪掉 .vs_back_end 底部按钮区（04:03 张老师：截图不要截到底部按钮）；
 * 根节点 #page 不带该类不受影响。
 */
async function buildShotBlob(): Promise<Blob> {
  const pg = document.getElementById("page") ?? document.body;
  const wrap = document.querySelector<HTMLElement>("#header .wrapper");
  const bg = getComputedStyle(document.body).backgroundColor || "#151515";
  const baseOpts = {
    pixelRatio: 2, // 与在线练习 renderShotPart 同款 2 倍清晰度
    backgroundColor: bg,
    style: {
      zoom: "1",
      transform: "none",
      margin: "0",
      position: "relative",
      left: "0",
      top: "0",
      boxSizing: "border-box", // offsetWidth/Height 含 padding+border，避免右下被挤出
    },
  };
  const shotOpts = (el: HTMLElement) => ({
    ...baseOpts,
    width: el.offsetWidth,
    height: Math.max(1, el.offsetHeight),
    canvasWidth: Math.max(1, Math.round(el.offsetWidth)),
    canvasHeight: Math.max(1, Math.round(el.offsetHeight)),
  });
  const [pageCv, headCv] = await Promise.all([
    // ⚠️ filter 会被调到 Text 节点（无 classList），必须先判存在再 contains，
    // 否则整个截图克隆直接 TypeError（2026-11-11 移动端实测踩过）
    toCanvas(pg, {
      ...shotOpts(pg),
      filter: (n: HTMLElement) => !(n.classList && n.classList.contains("vs_back_end")),
    }),
    // header 隐藏（移动端）时 offsetWidth=0，跳过避免截出 1px 空条
    wrap && wrap.offsetWidth > 0 ? toCanvas(wrap, shotOpts(wrap)) : Promise.resolve(null),
  ]);
  // 拼接：header 条置顶（居中），#page 接其下；左右各扩 40px 逻辑留白
  const GUTTER = 40; // 逻辑 px
  const scale = pageCv.width / Math.max(1, pg.offsetWidth);
  const gutter = Math.round(GUTTER * scale);
  const out = document.createElement("canvas");
  out.width = pageCv.width + gutter * 2;
  out.height = (headCv ? headCv.height : 0) + pageCv.height;
  const cx = out.getContext("2d");
  let final = pageCv;
  if (cx) {
    cx.fillStyle = bg;
    cx.fillRect(0, 0, out.width, out.height);
    if (headCv) cx.drawImage(headCv, Math.round((out.width - headCv.width) / 2), 0);
    cx.drawImage(pageCv, gutter, headCv ? headCv.height : 0);
    final = out;
  }
  return new Promise<Blob>((resolve, reject) => {
    final.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png");
  });
}


/** 战前评价色调（与 lib/vs.ts 的 PreTone 同值；客户端不 import 服务端数据模块） */
type PreTone = "adv" | "dis" | "even";

type Phase = "ready" | "exiting" | "running" | "done";

export function VsScoreBoard({
  total1,
  total2,
  winner,
  preComment,
  preTone,
  postComment,
  opponentId,
  dateStr,
  swap = null,
  hist,
  histHidden = false,
  leftPanel,
  rightPanel,
  below,
}: {
  /** 左侧（自己）最终总分 */
  total1: number;
  /** 右侧（对方）最终总分 */
  total2: number;
  /** 1=自己胜 / 2=自己败 / 0=平局 */
  winner: number;
  /** 战前预估评价（只看双方总 STNB，服务端算好，不剧透结果） */
  preComment: string;
  /** 战前评价色调：adv=占优绿 / dis=不利玫瑰红 / even=势均力敌金 */
  preTone: PreTone;
  /** 赛后评价（按总分差距，服务端算好） */
  postComment: string;
  /** 对手玩家 id（22:36 张老师：赛后「返回」按钮跳回对手用户主页，原地导航） */
  opponentId: number;
  /** 日期时间（16:26 张老师：进页立刻呈现——服务端算好传入，不再等水合后置空填） */
  dateStr: string;
  /** 换人就地回竞技场的卡片数据（16:36 张老师：换人不清屏——历史对决板块保留、
   *  画面不跳，只是清空对应卡片）。me=登录者卡，left/right=当前对决双方卡
   *  （服务端从对决数据转换，零额外查询）；null=不提供（不响应换人） */
  swap?: { me: VsPickPlayer; left: VsPickPlayer; right: VsPickPlayer } | null;
  /** 「历史对决」板块数据（2026-11-11 14:38 张老师：分割线下默认（赛前）即渲染；
   *  15:48：开跑后整块消失；17:23：改传**数据**由本组件渲染 VsHistBlock——
   *  换人（就位态就地切竞技场）后 uids 跟随 arena 侧卡片，VsHistFeed 自动重拉；
   *  竞技场形态（arena 非 null）时取 arena 两侧卡片 id（空位=0） */
  hist: { uid1: number; uid2: number; rows: VsHistRow[]; total: number; pageSize: number } | null;
  /** 自动跑分交接（17:24 张老师：点一决胜负落地瞬间历史会闪现又消失）——
   *  竞技场交接时写 vs_autorun cookie，SSR 读到即判定「马上开跑」，
   *  历史板块从首帧就不渲染（原 sessionStorage 方案 SSR 无从知晓，必闪） */
  histHidden?: boolean;
  /** 左右玩家面板：RSC 节点，作为 props 传入客户端边界 */
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  /** 下方所有比较板块：RSC 节点，跑分完成后才挂载 */
  below: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  // 自动跑分交接的历史抑制（17:24 张老师：落地瞬间历史闪现又消失）——SSR 传
  // histHidden 只为压住首帧；startFight 消费标记即解除（否则赛后点换人回就位态
  // 时历史板块永远回不来）
  const [histSuppressed, setHistSuppressed] = useState(histHidden);
  const [elapsed, setElapsed] = useState(0);
  const [reveal, setReveal] = useState(false);
  // 23:44 张老师：决出胜负按钮下方的音效开关——默认开，状态记 localStorage「vs_snd」；
  // 关时不播任何声音（跑分音 + 结算音全禁）。SSR 无 localStorage，挂载后读回真值。
  const [sndOn, setSndOn] = useState(true);
  // 00:45 张老师：日期时间恢复显示——PC 在「还是算了」下方（动作槽后独立行），
  // 移动端在页面最底部（grid 末行）；持续显示不渐隐。
  // 16:26 张老师：进页立刻呈现——改由服务端算好经 props 传入（原挂载 effect
  // 置值会先渲染一拍空日期，水合后才补上）
  // 换人就地回竞技场（16:36 张老师：换人不清屏）：非 null=已切到竞技场形态
  // （VsPickArena 渲染于原 #vs_hero 位置，URL 由其内部同步 effect 改写），
  // 历史对决板块保留、phase 不变（仍 ready，可重新选满开跑）。
  const [arena, setArena] = useState<{
    me: VsPickPlayer;
    left: VsPickPlayer | null;
    right: VsPickPlayer | null;
  } | null>(null);
  const swapRef = useRef(swap);
  swapRef.current = swap;
  // 跑分/结算 effect 内读 ref，避免把 sndOn 挂进依赖导致动画 effect 重启
  const sndRef = useRef(true);
  const riseRef = useRef<HTMLAudioElement>(null);
  const resultRef = useRef<HTMLAudioElement>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  sndRef.current = sndOn;

  useEffect(() => {
    try {
      setSndOn(localStorage.getItem("vs_snd") !== "0");
    } catch {}
  }, []);

  const toggleSnd = () => {
    setSndOn((v) => {
      const next = !v;
      try {
        localStorage.setItem("vs_snd", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  // 2026-11-10 19:10 张老师：我方胜利时终局评价用金色（与胜方分数/胜字同款 #fdc61a），
  // 失败与平局仍用亮灰；winner=1 即我方胜（p1 恒为登录者），由 .vs_post_win 上色。
  const tie = winner === 0;
  const loserScore = winner === 1 ? total2 : total1;
  const winnerScore = winner === 1 ? total1 : total2;
  const animMs = tie ? CLIMB_MS : CLIMB_MS + SURGE_MS;

  // 交接标记读写（17:24 改 cookie）：竞技场写 vs_autorun=<时间戳>（path=/vs,
  // 10s 过期）；SSR（page.tsx 读同一 cookie）判定「马上开跑」隐藏历史板块——
  // sessionStorage 方案 SSR 读不到，历史闪现又消失就是这么来的
  const readAutorun = (): number => {
    const m = /(?:^|;\s*)vs_autorun=(\d+)/.exec(document.cookie);
    const ts = m ? parseInt(m[1], 10) : 0;
    return ts && Date.now() - ts < 8000 ? ts : 0;
  };
  const clearAutorun = () => {
    document.cookie = "vs_autorun=; path=/vs; max-age=0; SameSite=Lax";
  };

  const startFight = () => {
    if (phase !== "ready") return;
    // 交接标记在此消费（挂载 effect 只读不删——StrictMode 双挂载下首挂载
    // 删标记、cleanup 清计时器会让二挂载丢指令；开跑即删，过期标记无害）
    clearAutorun();
    setHistSuppressed(false); // 历史抑制只护首帧，此后（含赛后换人回就位态）正常显隐
    // data-close 由 phase 驱动：面板立刻开始向左右滑，滑完（SPREAD_MS）才跑分
    setPhase("exiting");
    fadeTimer.current = setTimeout(() => setPhase("running"), SPREAD_MS);
  };

  // 竞技场「一决胜负」交接自动开跑（十轮 14:11 张老师：URL 不带参数）——
  // 标记为竞技场写入的时间戳 cookie，新鲜（8s 内）即 400ms 后 startFight（八轮
  // 13:29：点一下直接开跑免二次点击）；直接访问/刷新无标记或标记过期 → 手动两段式
  useEffect(() => {
    if (!readAutorun()) return;
    const t = setTimeout(startFight, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时触发一次
  }, []);

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
  }, []);

  // 换人就地切换（16:36 张老师）：VsSwapX 广播「vs_swap」，这里清对应侧卡片、
  // 切到竞技场形态。就位态直接切；赛后（17:25 张老师：赛后点换人没反应）也响应——
  // 回到就位态（below 跑分明细随之卸载、历史对决板块重新出现，正好顶替其位置）
  useEffect(() => {
    const onSwap = (e: Event) => {
      const side = (e as CustomEvent<{ side?: "l" | "r" }>).detail?.side;
      const s = swapRef.current;
      if (!s || (side !== "l" && side !== "r")) return;
      if (phase !== "ready" && phase !== "done") return;
      setArena(
        side === "l"
          ? { me: s.me, left: null, right: s.right }
          : { me: s.me, left: s.left, right: null }
      );
      if (phase === "done") {
        // 重置跑分残留：reveal 不清会在二轮就位态直接显示上轮「胜/败」字
        setReveal(false);
        setElapsed(0);
        setPhase("ready");
      }
    };
    window.addEventListener("vs_swap", onSwap);
    return () => window.removeEventListener("vs_swap", onSwap);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- phase 只需挂载/卸载判定最新值
  }, [phase]);

  // 2026-11-10 21:46 张老师：移动端 tap BV 格要显示 hover 气泡。
  // iOS Safari 对 span[tabindex] 的点击聚焦不可靠，且触屏残留 :hover/:focus 会常驻，
  // 纯 CSS 不够——改用 document 级 pointerdown 委托（只处理触屏，桌面鼠标仍走 :hover），
  // 切 .vs_tip_on class：点格子开、再点同格关、点其它格/空白自动关。
  // 事件 target 由浏览器真实命中测试给出，不受 WebKit zoom 子树 gBCR 坐标失真影响。
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const cell = (e.target as Element | null)?.closest?.(".vs_c") as HTMLElement | null;
      document.querySelectorAll(".vs_c.vs_tip_on").forEach((el) => {
        if (el !== cell) el.classList.remove("vs_tip_on");
      });
      if (!cell) return;
      if (cell.classList.contains("vs_tip_on")) cell.classList.remove("vs_tip_on");
      else cell.classList.add("vs_tip_on");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // hover 音效（2026-11-11 14:38 张老师）：悬停纪录行（.vs_rec tr）或 BV 格
  // （.vs_c）时播放一次短促音。下方板块是 RSC 节点，交互走 document 级
  // mouseover 委托；同一格/行内划过子元素不重播（按进入的容器元素去重），
  // 音效开关关时不播。
  const hoverRef = useRef<HTMLAudioElement>(null);
  const lastHoverEl = useRef<Element | null>(null);
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const el = t?.closest?.(".vs_c, .vs_rec tbody tr") ?? null;
      if (!el || el === lastHoverEl.current) return;
      lastHoverEl.current = el;
      if (!sndRef.current) return;
      const a = hoverRef.current;
      if (a) {
        a.currentTime = 0;
        a.volume = HOVER_VOLUME;
        void a.play().catch(() => {});
      }
    };
    document.addEventListener("mouseover", onOver, true);
    return () => document.removeEventListener("mouseover", onOver, true);
  }, []);

  // 跑分动画：只有 phase=running 才启动（按钮淡出 + 面板滑开之后）
  useEffect(() => {
    if (phase !== "running") return;
    const rise = riseRef.current;
    let raf = 0;
    let startTs = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (rise) {
        rise.pause();
        rise.currentTime = 0;
      }
      setReveal(true);
      setPhase("done"); // 下方板块与赛后评价由此出现
    };
    const tick = (ts: number) => {
      if (!startTs) startTs = ts;
      const e = ts - startTs;
      setElapsed(Math.min(e, animMs));
      if (e >= animMs) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    if (rise && sndRef.current) {
      rise.currentTime = 0;
      rise.volume = RISE_VOLUME;
      void rise.play().catch(() => {}); // 按钮点击已带手势，正常路径必可播
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      finished = true;
      if (rise) rise.pause();
    };
  }, [phase, animMs]);

  // 结算音：赛后才播，独立 effect 避免被跑分 effect 的 cleanup 掐断；音效关时不播
  useEffect(() => {
    if (phase !== "done" || tie || !sndRef.current) return;
    const a = resultRef.current;
    if (!a) return;
    a.volume = RESULT_VOLUME;
    a.currentTime = 0;
    void a.play().catch((e: unknown) => {
      if ((e as DOMException)?.name !== "NotAllowedError") return;
      // 极严自动播放策略：任意点击页面补播一次，不新增界面元素
      const replay = () => {
        void a.play().catch(() => {});
        document.removeEventListener("pointerdown", replay);
      };
      document.addEventListener("pointerdown", replay);
    });
    return () => {
      a.pause();
      a.currentTime = 0;
    };
  }, [phase, tie]);

  // 赛后自动截屏（2026-11-11 张老师需求）：决出胜负后把 960 内容列截成 PNG 复制
  // 到剪贴板，绿色气泡「已截图并复制到剪贴板」。
  // 构图（03:18/03:29 张老师定）：截 #page（960 水平居中内容列，从英雄区到高级
  // 板块从头到尾）+ 顶部拼 #header .wrapper（同为 960 对齐，带站名 logo）；
  // 克隆 body 整宽渲染会把 margin:auto 居中丢掉（内容挤左、右侧空白、header 歪），
  // 而克隆 #page 又丢 body 深底 → backgroundColor 显式补背景色。
  // 时序（03:26 张老师定，不等声音放完）：声音开＝跑分结束 3s 后播截屏音
  // （capture.mp3，在线练习同款）+ 出气泡；声音关＝剪贴板一落就出气泡
  // （截图本体渲染约 1~2s，「1s 出气泡」时剪贴板还写不完，气泡必须真有其事）。
  // 截图本体在「页面元素停止变化」的瞬间即开截（03:38 张老师定）：rAF 轮询
  // .vs_below（0.55s 淡入）与胜/败字（0.6s 渐显）的 opacity，全部到位立刻
  // 渲染落盘（transient activation 窗口内），气泡/截屏音按上述时刻延后。
  const shotRef = useRef<HTMLAudioElement>(null);
  // 移动端「保存到相册」的截图缓存：done 后台预生成，点击时秒出分享面板
  //（navigator.share 必须在 transient activation 手势窗内调用，现场生成 1~2s
  // 会超时被 iOS 拒掉，所以必须提前备好）
  const shotBlobRef = useRef<Blob | null>(null);
  useEffect(() => {
    if (phase !== "done") return;
    let cancelled = false;
    // 03:59 张老师：移动端不写剪贴板不出气泡——移动端浏览器无法写剪贴板
    //（ClipboardItem/Safari iOS 均不可用），跳过截屏 effect，只后台预生成
    // 截图 Blob 给底部「保存到相册」按钮用
    if (window.matchMedia("(max-width: 768px)").matches) {
      void waitSettled()
        .then(() => buildShotBlob())
        .then((b) => {
          if (!cancelled) shotBlobRef.current = b;
        })
        .catch(() => {}); // 预生成失败静默，点击时现场重试
      return () => {
        cancelled = true;
      };
    }
    const doneAt = Date.now(); // 跑分结束时刻，3s 延迟基准
    const run = async () => {
      // 元素停止变化即开截（03:38 张老师定）
      await waitSettled();
      if (cancelled) return;
      try {
        const blob = await buildShotBlob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        if (cancelled) return;
        // 气泡/截屏音：声音开＝done+3s 播截屏音+气泡；声音关＝剪贴板一落就出气泡
        //（截图本体渲染约 1~2s，1s 内物理上写不完剪贴板，气泡必须真有其事）
        const finish = () => {
          if (cancelled) return;
          if (sndRef.current) {
            const shot = shotRef.current;
            if (shot) {
              shot.currentTime = 0;
              shot.volume = RISE_VOLUME;
              void shot.play().catch(() => {});
            }
          }
          toast("已截图并复制到剪贴板", "success");
        };
        setTimeout(
          finish,
          sndRef.current ? Math.max(0, doneAt + 3000 - Date.now()) : 0,
        );
      } catch {
        if (!cancelled) toast("截图失败或剪贴板被拒绝", "error");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // 04:03 张老师：移动端底部「保存到相册」——点击出系统分享面板（iOS 选
  // 「存储图像」即存相册），不支持 files 分享的浏览器兜底直接下载 PNG。
  // 优先用 done 后预生成的缓存 Blob（保证 share 落在点击手势窗内）。
  const [saving, setSaving] = useState(false);
  const saveToAlbum = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const blob = shotBlobRef.current ?? (await buildShotBlob());
      const file = new File([blob], `vs-${opponentId}.png`, { type: "image/png" });
      const nav = navigator as Navigator & {
        canShare?: (data: { files?: File[] }) => boolean;
        share?: (data: { files?: File[] }) => Promise<void>;
      };
      let shared = false;
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        try {
          await nav.share({ files: [file] });
          shared = true;
        } catch (e) {
          // AbortError＝用户主动关掉分享面板，不算失败；NotAllowedError 等
          //（手势过期/环境弹不出面板）落到下面的下载兜底
          if ((e as DOMException)?.name === "AbortError") return;
        }
      }
      if (!shared) {
        // 下载兜底：iOS Safari 存到「文件」（长按可存相册），Android 直接进下载
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e) {
      // 用户在分享面板点取消（AbortError）不算失败，静默返回
      if ((e as DOMException)?.name !== "AbortError") toast("截图生成失败", "error");
    } finally {
      setSaving(false);
    }
  };

  // 01:18 张老师：赛后分割线宽度与两边玩家卡片边缘平齐——测量首尾 .vs_panel
  // 的跨度，inline 写到 divider 上（PC 端 absolute 定位用）；移动端卡片本就全宽，
  // 清空 inline 让 CSS 的 width:100% 生效。resize 时重算。
  // 2026-11-11 14:38 张老师：分割线**默认（赛前）即显示**——fit 不再只在 done 跑，
  // phase 变化时重测（面板收拢→滑开宽度随动）。
  // 16:26 张老师：「历史对决」板块宽度与分割线保持一致——同一测量值经 heroW
  // state 写进板块 wrapper（居中后即与分割线两缘平齐；移动端同为全宽）。
  // 16:36 张老师：换人切竞技场后面板不在，历史板块按最后测量值保持原宽不跳。
  const [heroW, setHeroW] = useState<number | null>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dividerRef.current;
    if (!el) return;
    const fit = () => {
      const hero = el.closest("#vs_hero");
      // 20:29 张老师：跑分期间（面板滑开中）分割线不显示——历史对决板块已随开跑
      // 摘除，fit 若照测滑开后的面板跨度，线会突变成横贯全宽的孤线（实测 ready
      // 790 → running 936）；就位/赛后照常显示测量
      if (phase === "exiting" || phase === "running") {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      const panels = hero?.querySelectorAll<HTMLElement>(".vs_panel");
      if (!hero || !panels || panels.length < 2) return;
      if (window.matchMedia("(max-width: 768px)").matches) {
        el.style.width = "";
        el.style.left = "";
        setHeroW(null);
        return;
      }
      const ob = el.offsetParent?.getBoundingClientRect(); // vs_vs（position:relative）
      const l = panels[0].getBoundingClientRect();
      const r = panels[panels.length - 1].getBoundingClientRect();
      if (!ob) return;
      el.style.width = `${Math.round(r.right - l.left)}px`;
      el.style.left = `${Math.round(l.left - ob.left)}px`;
      setHeroW(Math.round(r.right - l.left));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [phase]);

  const climbP = Math.min(elapsed / CLIMB_MS, 1);
  const base = loserScore * climbP;
  const golden = !tie && elapsed >= CLIMB_MS;
  const surgeP = tie ? 0 : Math.min(Math.max(elapsed - CLIMB_MS, 0) / SURGE_MS, 1);
  const surge = (winnerScore - loserScore) * surgeP;
  const v1 = winner === 1 ? base + surge : base;
  const v2 = winner === 2 ? base + surge : base;
  const showNum = phase === "running" || phase === "done";

  const sideClass = (isWinnerSide: boolean) =>
    "vs_total" + (golden && isWinnerSide ? " vs_total_win" : "");
  const markClass = (isWinnerSide: boolean) =>
    "vs_mark " + (isWinnerSide ? "vs_mark_win" : "vs_mark_lose") + (reveal ? " vs_mark_show" : "");
  const numClass = "vs_num" + (showNum ? "" : " vs_num_hide");
  const preClass = `vs_pre vs_pre_${preTone}` + (phase !== "ready" ? " vs_pre_out" : "");

  return (
    <>
      {arena ? (
        /* 换人就地切回竞技场形态（16:36 张老师：换人不清屏——画面不跳、历史
           对决板块保留）：VsPickArena 挂载后其 URL 同步 effect 自动把地址改成
           /vs?/{右id} 或 /vs/{左id}；重新选满双方「一决胜负」经 sessionStorage
           交接跳 /vs/{l}/{r}，与竞技场主路径同一套行为 */
        <VsPickArena me={arena.me} initialLeft={arena.left} initialRight={arena.right} />
      ) : (
        <div id="vs_hero" data-close={phase === "ready" ? "1" : "0"} data-done={phase === "done" ? "1" : "0"}>
        {leftPanel}
        <div className="vs_vs">
          {/* 顶部评价位（22:36 张老师：终局评价与开盘预测放**相同的位置**——
              赛前渲染战前预估（点击后渐隐），赛后原位换成终局评价，同款卡片框） */}
          {/* 00:08 张老师定稿（中间列 grid 五行 auto/1fr/auto/1fr/auto）：
              row1 预测气泡（顶对齐卡片）/ row2 日期槽（气泡与 VS 图标的视觉中点，
              padding-top 44px 补偿 scoreline 上内边距）/ row3 VS 行（两 1fr 均衡
              → 图标严格垂直居中于卡片）/ row4 喇叭槽（图标与按钮的视觉中点，
              padding-bottom 44px 补偿下内边距）/ row5 动作槽（贴卡片底端）。
              各阶段只换行内内容、行高不变 → 跑分/赛后零跳动 */}
          {phase === "done" ? (
            /* 00:18 张老师：终局评价移到动作槽（原「返回」按钮的位置）；row1 留
               透明占位（同尺寸气泡）保住行高，跑分前后 scoreline 零跳动 */
            <div className={"vs_prewrap vs_pre_out"} aria-hidden="true">
              <div className="vs_pre">{preComment}</div>
            </div>
          ) : (
            <div className={"vs_prewrap" + (phase !== "ready" ? " vs_pre_out" : "")}>
              <div className={preClass}>{preComment}</div>
            </div>
          )}
          {phase === "done" && (
            /* 04:03 张老师：移动端终局评价回顶部预测位（#vs_hero grid row1，
               与上面透明占位叠同一格、DOM 后者在上）——动作槽腾空后 hero 变矮，
               下方板块在首屏露出个头，用户才知道下面还有内容。
               PC 端 display:none（终局评价仍在动作槽），仅移动端显示 */
            <p className={"vs_post vs_post_top" + (winner === 1 ? " vs_post_win" : "")}>
              {postComment}
            </p>
          )}
          {/* 两个 audio 留在 DOM 里（display:none 不影响播放），便于观察播放状态 */}
          {/* 张老师 18:12 + 19:07：数字滚动音只播一次，绝不加 loop */}
          <audio ref={riseRef} src={`${RISE_SOUND}?v=${SND_VER}`} preload="auto" />
          {/* hover 音效（纪录行 / BV 格悬停短促音，2026-11-11 14:38 张老师指定） */}
          <audio ref={hoverRef} src={`${HOVER_SOUND}?v=${SND_VER}`} preload="auto" />
          {/* 赛后自动截屏提示音（与在线练习 capture.mp3 同款，只播一次） */}
          <audio ref={shotRef} src={`/sounds/capture.mp3?v=${SND_VER}`} preload="auto" />
          {!tie && (
            <audio
              ref={resultRef}
              src={`${winner === 1 ? WIN_SOUND : LOSE_SOUND}?v=${SND_VER}`}
              preload="auto"
            />
          )}
          <div className="vs_scoreline">
            {/* .vs_ghost 是隐藏的最终分数占位：钉死宽度，避免 0.00→136.00 推得抖动 */}
            <span className={sideClass(winner === 1)}>
              <span className="vs_ghost" aria-hidden="true">{total1.toFixed(2)}</span>
              <span className={numClass}>{v1.toFixed(2)}</span>
              {!tie && <i className={markClass(winner === 1)}>{winner === 1 ? "胜" : "败"}</i>}
            </span>
            {/* VS 战斗字标（与入口按钮同源，96px 原色展示） */}
            {/* eslint-disable-next-line @next/next/no-img-element -- 固定静态资源 */}
            <img src="/icons/clash.png" alt="" width={96} height={102} draggable={false} />
            <span className={sideClass(winner === 2)}>
              <span className="vs_ghost" aria-hidden="true">{total2.toFixed(2)}</span>
              <span className={numClass}>{v2.toFixed(2)}</span>
              {!tie && <i className={markClass(winner === 2)}>{winner === 2 ? "胜" : "败"}</i>}
            </span>
          </div>
          {/* 01:01 张老师改版：PC 动作槽纵向 = 「决出胜负」+ 喇叭开关（正下方），
              不显示「返回」（页面底部已有 .vs_back_end）；移动端一行三列 grid：
              喇叭靠左、按钮**居中**、「返回」（原「还是算了」）靠右。
              done 时整槽换成终局评价；黄色=开/灰=关，状态记 localStorage「vs_snd」 */}
          <div className="vs_action">
            {phase !== "done" ? (
              <>
                <button
                  type="button"
                  className={"vs_fight" + (phase === "ready" ? "" : " vs_fight_out")}
                  onClick={startFight}
                  disabled={phase !== "ready"}
                >
                  一决胜负
                </button>
                {/* 01:01 张老师：灰色「返回」（原「还是算了」）——点击直接返回对手主页；
                    仅移动端显示（居右），running 后保留透明占位防行高变化，done 随槽卸载 */}
                <Link
                  className={
                    "vs_cancel" + (phase !== "ready" ? " vs_fight_out" : "")
                  }
                  href={`/user/${opponentId}`}
                >
                  返回
                </Link>
                <button
                  type="button"
                  className={"vs_snd_gsw" + (sndOn ? "" : " vs_snd_off") +
                    (phase !== "ready" ? " vs_fight_out" : "")}
                  onClick={toggleSnd}
                  aria-pressed={sndOn}
                  aria-label={sndOn ? "音效打开" : "音效关闭"}
                  data-tip={sndOn ? "音效打开" : "音效关闭"}
                >
                  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                    {/* 喇叭体（实心）+ 右侧两道声波弧线，描边圆头，颜色走 currentColor */}
                    <path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor" />
                    <path
                      d="M14.5 8.7a4.6 4.6 0 0 1 0 6.6"
                      stroke="currentColor"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      fill="none"
                    />
                    <path
                      d="M17.6 6a9 9 0 0 1 0 12"
                      stroke="currentColor"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              </>
            ) : (
              /* 00:18 张老师：终局评价显示在原「返回」按钮的位置（动作槽、贴卡片底端）；
                 「返回」移到页面最底部（.vs_back_end，PC/移动端一致） */
              <p className={"vs_post" + (winner === 1 ? " vs_post_win" : "")}>{postComment}</p>
            )}
          </div>
          {/* 01:45 张老师：日期时间——PC 紧跟动作槽（喇叭下方）；移动端拆箱后落
              grid 末行（页面最底部）。持续显示。
              01:02 张老师：跑完分后日期下方加一条分割线，上下 40px 留白 */}
          <span className="vs_date">{dateStr}</span>
          {/* 2026-11-11 14:38 张老师：分割线默认（赛前）即显示，不再只在赛后出现 */}
          <div className="vs_divider" ref={dividerRef} aria-hidden="true" />
        </div>
        {rightPanel}
        </div>
      )}
      {/* 「历史对决」板块（2026-11-11 14:38 张老师）：分割线下默认即渲染；
          15:48 张老师：开始跑分后整块消失（仅「就位」态可见）；16:26 张老师：
          板块宽度与分割线一致（fit 测量值经 heroW 写进 wrapper，margin auto 居中）；
          16:36 张老师：换人切竞技场形态后保留；17:23 张老师：uids 跟随竞技场
          两侧卡片（空位=0，单边按该玩家发起的记录查），VsHistFeed 自动重拉；
          17:24 张老师：自动跑分交接（histHidden，SSR 读 cookie 判定）时首帧
          就不渲染——否则落地瞬间历史闪现又消失 */}
      {phase === "ready" && !histSuppressed && hist && (hist.uid1 || hist.uid2) && (
        <div className="vs_hist_wrap" style={heroW ? { width: heroW } : undefined}>
          <VsHistBlock
            uid1={arena ? arena.left?.id ?? 0 : hist.uid1}
            uid2={arena ? arena.right?.id ?? 0 : hist.uid2}
            initial={hist.rows}
            total={hist.total}
            pageSize={hist.pageSize}
          />
        </div>
      )}
      {/* 跑分完成后下方各板块才出现（RSC 节点，赛前不在可见 DOM 中） */}
      {phase === "done" && <div className="vs_below">{below}</div>}
      {/* 00:18 张老师：PC/移动端「返回」统一移到页面最底部（footer 之上），按钮加大 */}
      {phase === "done" && (
        <div className="vs_back_end">
          {/* 04:03 张老师：移动端返回左边加黄色「保存到相册」——点击出系统分享
              面板选「存储图像」即存相册（截图用 done 时预生成的缓存 Blob，
              已排除本按钮区）；PC 端隐藏 */}
          <button
            type="button"
            className="vs_save_album"
            onClick={saveToAlbum}
            disabled={saving}
          >
            {saving ? "生成中…" : "保存到相册"}
          </button>
          <Link className="vs_back" href={`/user/${opponentId}`}>
            返回
          </Link>
        </div>
      )}
    </>
  );
}
