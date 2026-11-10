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
  /** 左右玩家面板：RSC 节点，作为 props 传入客户端边界 */
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  /** 下方所有比较板块：RSC 节点，跑分完成后才挂载 */
  below: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [elapsed, setElapsed] = useState(0);
  const [reveal, setReveal] = useState(false);
  // 23:44 张老师：决出胜负按钮下方的音效开关——默认开，状态记 localStorage「vs_snd」；
  // 关时不播任何声音（跑分音 + 结算音全禁）。SSR 无 localStorage，挂载后读回真值。
  const [sndOn, setSndOn] = useState(true);
  // 00:45 张老师：日期时间恢复显示——PC 在「还是算了」下方（动作槽后独立行），
  // 移动端在页面最底部（grid 末行）；持续显示不渐隐
  const [dateStr, setDateStr] = useState("");
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
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    setDateStr(`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`);
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

  const startFight = () => {
    if (phase !== "ready") return;
    // data-close 由 phase 驱动：面板立刻开始向左右滑，滑完（SPREAD_MS）才跑分
    setPhase("exiting");
    fadeTimer.current = setTimeout(() => setPhase("running"), SPREAD_MS);
  };

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
  }, []);

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
  useEffect(() => {
    if (phase !== "done") return;
    let cancelled = false;
    const doneAt = Date.now(); // 跑分结束时刻，3s/1s 延迟基准
    const run = async () => {
      // 元素停止变化即开截：等所有渐显元素 opacity 到 1（1.5s 兜底防卡死）
      await new Promise<void>((res) => {
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
      if (cancelled) return;
      try {
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
          toCanvas(pg, shotOpts(pg)),
          wrap ? toCanvas(wrap, shotOpts(wrap)) : Promise.resolve(null),
        ]);
        // 拼接：header 条置顶（居中），#page 接其下；左右各扩 40px 逻辑留白
        //（03:39 张老师：960 截出来太满，左右扩上 40px）
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
        const blob = await new Promise<Blob>((resolve, reject) => {
          final.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png");
        });
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

  // 01:18 张老师：赛后分割线宽度与两边玩家卡片边缘平齐——测量首尾 .vs_panel
  // 的跨度，inline 写到 divider 上（PC 端 absolute 定位用）；移动端卡片本就全宽，
  // 清空 inline 让 CSS 的 width:100% 生效。resize 时重算。
  const dividerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase !== "done") return;
    const el = dividerRef.current;
    if (!el) return;
    const fit = () => {
      const hero = el.closest("#vs_hero");
      const panels = hero?.querySelectorAll<HTMLElement>(".vs_panel");
      if (!hero || !panels || panels.length < 2) return;
      if (window.matchMedia("(max-width: 768px)").matches) {
        el.style.width = "";
        el.style.left = "";
        return;
      }
      const ob = el.offsetParent?.getBoundingClientRect(); // vs_vs（position:relative）
      const l = panels[0].getBoundingClientRect();
      const r = panels[panels.length - 1].getBoundingClientRect();
      if (!ob) return;
      el.style.width = `${Math.round(r.right - l.left)}px`;
      el.style.left = `${Math.round(l.left - ob.left)}px`;
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
      <div id="vs_hero" data-close={phase === "ready" ? "1" : "0"}>
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
          {/* 两个 audio 留在 DOM 里（display:none 不影响播放），便于观察播放状态 */}
          {/* 张老师 18:12 + 19:07：数字滚动音只播一次，绝不加 loop */}
          <audio ref={riseRef} src={`${RISE_SOUND}?v=${SND_VER}`} preload="auto" />
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
                  决出胜负
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
          {phase === "done" && <div className="vs_divider" ref={dividerRef} aria-hidden="true" />}
        </div>
        {rightPanel}
      </div>
      {/* 跑分完成后下方各板块才出现（RSC 节点，赛前不在可见 DOM 中） */}
      {phase === "done" && <div className="vs_below">{below}</div>}
      {/* 00:18 张老师：PC/移动端「返回」统一移到页面最底部（footer 之上），按钮加大 */}
      {phase === "done" && (
        <div className="vs_back_end">
          <Link className="vs_back" href={`/user/${opponentId}`}>
            返回
          </Link>
        </div>
      )}
    </>
  );
}
