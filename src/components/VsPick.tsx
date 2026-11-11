"use client";

// /vs 对决选择页 = 竞技场（2026-11-11 张老师需求，五轮 13:38 起为 /vs 系唯一页面）：
//   · URL 即状态：/vs（空，服务端预填自己）· /vs/{l}（只左）· /vs//{r}（只右）
//     · /vs/{l}/{r}（双卡）；选人/换人/清空实时 replaceState（见 URL 同步 effect）；
//   · 左侧放自己（初始数据由服务端传入），右侧空位 = 问号头像 + 搜索框
//     （同排行搜索：防抖 250ms 调 /api/ranking/search，下拉键盘上下选、回车/点击选定；
//     空内容聚焦且自己不在场上时下拉直接推荐自己——四轮 11:23）；
//   · 选定对手后拉 /api/vs/player 渲染该玩家卡片 + 实力雷达
//     （卡片结构与 /vs/[id] 的 VsPanel 完全同源）；
//   · 有玩家的卡片右上角圆角处一律出深灰 X 圆形按钮（未选定对手时我方卡片也有，
//     二轮 10:45 张老师：可以两边全空），hover 出上方气泡「换人」，
//     点击清空该卡片回到「问号头像 + 搜索框」空位态（与右侧初始 UI 完全一致）；
//   · 中间列完全复用 PK 页（/vs/[id]）布局：.vs_vs（.vs_scoreline VS 战斗字标 +
//     .vs_action 对决按钮 + 喇叭音效开关）——音效开关与 PK 页共用
//     localStorage「vs_snd」；按钮三态：双方就位=「一决胜负」进 /vs/{对手id}、
//     单边有玩家=「匹配对手」（七轮 13:13：自动匹配全国排名 ±50 的对手填空位）、
//     两边全空=置灰。
// 约束：任一边可选自己；仅当一边已是自己、另一边再选自己时提示「不能和自己比拼」；
//   同一玩家（非自己）不能同时站两边。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "./Toast";
import { AvatarCell, TitleBadge } from "./Cells";
import { DefaultAvatar } from "./DefaultAvatar";
import { RadarChart } from "./RadarChart";
import { VsHistBlock } from "./VsHistBlock";
import { AREA_OVERSEAS, areaDisplay } from "@/lib/config";
import type { RadarPoint } from "@/lib/radar";
import type { VsHistRow } from "@/lib/vs";

/** 玩家卡片数据（/vs/page.tsx 服务端组装初始「自己」；/api/vs/player 返回选定对手） */
export interface VsPickPlayer {
  id: number;
  name: string;
  en: string;
  sex: number;
  avatarUrl: string;
  /** 无头像（走默认图）：军衔制下按性别渲染军装默认头像 */
  avatarIsDefault: boolean;
  militaryTitle: string;
  /** 旧版称号备选（TitleBadge classic 双体系渲染，与玩家卡片一致） */
  classicTitle: { name: string; color: string } | null;
  area: string;
  areaRank: number | null;
  natRank: number | null;
  radar: RadarPoint[];
}

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

/** 预测评价色调（与 lib/vs.ts 的 PreTone 同值；客户端不 import 服务端数据模块） */
type PreTone = "adv" | "dis" | "even";

/** 搜索框（同排行搜索交互）：防抖推荐下拉 + 键盘导航；选定即回调并清空输入。
 *  空内容聚焦时若自己不在场上（suggestSelf 非空），下拉直接推荐自己（四轮 11:23 张老师）。 */
function VsSearch({
  onPick,
  suggestSelf,
}: {
  onPick: (u: SuggestUser) => void;
  suggestSelf: SuggestUser | null;
}) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<SuggestUser[] | null>(null);
  const [active, setActive] = useState(0); // 键盘上下键游标
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效

  const kw = q.trim();
  const numeric = /^\d+$/.test(kw);
  // 空内容聚焦出的「推荐自己」下拉（与搜索下拉共用 users 状态；kw 非空时走搜索）
  const selfShown = users !== null && kw === "";
  // 无匹配空态提示（与排行搜索同文案口径）
  const emptyMsg = numeric ? `没有找到ID为${kw}的玩家` : "没有找到符合条件的玩家";

  // 防抖 250ms 模糊推荐（setState 只发生在异步回调里，规避 set-state-in-effect）
  useEffect(() => {
    const kw = q.trim();
    if (!kw) {
      reqSeq.current++; // 使在途请求失效
      setUsers(null);
      return;
    }
    const seq = ++reqSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(kw)}&limit=8`);
        if (!res.ok) return;
        const { users: list } = (await res.json()) as { users: SuggestUser[] };
        if (seq !== reqSeq.current) return; // 已有更新的输入
        setUsers(list);
        setActive(0);
      } catch {
        /* 网络异常静默 */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  // 点击外部收起下拉
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setUsers(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  function pick(u: SuggestUser) {
    setUsers(null);
    setQ("");
    onPick(u);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (users === null || users.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % users.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + users.length) % users.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const u = users[active];
      if (u) pick(u);
    } else if (e.key === "Escape") {
      setUsers(null);
    }
  }

  return (
    <div className="goto_form" ref={boxRef}>
      <span className="goto_search">
        <svg className="goto_icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="9.4" y1="9.4" x2="13" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={q}
          maxLength={12}
          placeholder="搜索玩家（姓名/ID）"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            // 空内容聚焦：自己不在两边场上时，下拉直接推荐自己
            if (!kw && suggestSelf) setUsers([suggestSelf]);
          }}
          autoComplete="off"
        />
      </span>
      {users !== null && (kw !== "" || selfShown) && (
        <ul className="goto_suggest">
          {users.length === 0 ? (
            <li className="goto_empty">{emptyMsg}</li>
          ) : (
            users.map((u, i) => (
              <li key={u.id} className={i === active ? "active" : undefined}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(u)}
                >
                  <em>{u.chineseName}</em>
                  {/* 对决页无榜别上下文，次级文字显示 ID；聚焦推荐自己的那条加「推荐」标 */}
                  <span>{selfShown && u.id === suggestSelf?.id ? `推荐 · ID ${u.id}` : `ID ${u.id}`}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** 玩家卡片：结构与 /vs/[id] 的 VsPanel 完全同源（.user_card 上半部 + 横线 + 实力雷达）。
 *  右上角圆角处恒渲染「换人」X 按钮（10:45 张老师：只要卡上有玩家就有，可两边全空）。 */
function VsCard({ p, onSwap }: { p: VsPickPlayer; onSwap: () => void }) {
  return (
    <div className="box vs_panel">
      {onSwap && (
        <button type="button" className="vs_swap" aria-label="换人" onClick={onSwap}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <div className="user_card">
        <div className="ucd_top">
          <div className="ucd_left">
            <Link
              className="avatar_link"
              href={`/user/${p.id}`}
              target="_blank"
              prefetch={false}
              title={`进入 ${p.name} 的地盘`}
            >
              {/* 无头像：军衔制下按性别给军装默认头像（72px 位走 mid 档，与玩家卡片同款） */}
              {p.avatarIsDefault ? (
                <DefaultAvatar sex={p.sex} size="mid" className="ucd_avatar" alt={p.name} />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element -- 用户上传头像，走原 URL */
                <img className="ucd_avatar" src={p.avatarUrl} alt={p.name} />
              )}
            </Link>
          </div>
          <div className="ucd_right">
            <p className="ucd_name">
              <AvatarCell id={p.id} name={p.name} englishName={p.en} sex={p.sex} gender="small" link />
              <TitleBadge title={p.militaryTitle} classic={p.classicTitle} link />
            </p>
            {/* 地区 / 全国排名：与玩家卡片 .ranks 同构（海外玩家口径一致） */}
            <div className="ranks">
              {p.area === AREA_OVERSEAS ? (
                p.areaRank !== null ? (
                  <span className="rank_line">
                    海外第 <em>{p.areaRank}</em> 名
                  </span>
                ) : (
                  <span className="rank_line ranks_overseas">海外玩家</span>
                )
              ) : (
                <>
                  {p.areaRank !== null ? (
                    <span className="rank_line">
                      {areaDisplay(p.area)}第 <em>{p.areaRank}</em> 名
                    </span>
                  ) : (
                    <span className="rank_line ucd_null">未加入地区排行</span>
                  )}
                  {p.natRank !== null ? (
                    <span className="rank_line">
                      全国第 <em>{p.natRank}</em> 名
                    </span>
                  ) : (
                    <span className="rank_line ucd_null">未加入全国排行</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        <hr className="ucd_hr" />
        {p.radar.length > 0 && (
          <div className="vs_radar">
            <RadarChart data={p.radar} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 空位：问号头像占位 + 搜索框（刚进入页面时右侧的 UI；换人清空后回到同一形态）。
 *  头像用圆角矩形遮罩（2026-11-11 张老师：不要圆形），与搜索框的间距＝盒内上边距
 *  （.box padding 30px）→ 上下留白等同；头像宽度＝搜索框宽度（CSS 同撑内容宽 200px）。
 *  suggestSelf：自己不在两边场上时非空，空内容聚焦推荐自己。 */
function VsEmptySlot({
  onPick,
  suggestSelf,
}: {
  onPick: (u: SuggestUser) => void;
  suggestSelf: SuggestUser | null;
}) {
  return (
    <div
      className="box vs_panel vs_pick_empty"
      /* 16:38 张老师：hover 空卡自动聚焦搜索框（卡内唯一 input 即搜索框） */
      onMouseEnter={(e) => e.currentTarget.querySelector("input")?.focus()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 本地静态占位图 */}
      <img className="vs_pick_q" src="/images/common/avatar.png" alt="?" />
      <VsSearch onPick={onPick} suggestSelf={suggestSelf} />
    </div>
  );
}

/** 喇叭音效开关：结构与 PK 页 VsScoreBoard 的 .vs_snd_gsw 完全同源（含 hover
 *  上方 data-tip 气泡），共用 localStorage「vs_snd」——进对决页前先定好音效。 */
function SndSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={"vs_snd_gsw" + (on ? "" : " vs_snd_off")}
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? "音效打开" : "音效关闭"}
      data-tip={on ? "音效打开" : "音效关闭"}
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
  );
}

export function VsPickArena({
  me,
  initialLeft = null,
  initialRight = null,
  hist = null,
  dateStr,
}: {
  /** 登录者自己（服务端预取） */
  me: VsPickPlayer;
  /** URL 段带来的初始左/右卡（/vs/{l}、/vs/{l}/{r} 直达；裸 /vs 由服务端预填自己）。
   *  选中/换人/清空后由 URL 同步 effect 实时改地址栏（五轮 13:38 张老师口径）。 */
  initialLeft?: VsPickPlayer | null;
  initialRight?: VsPickPlayer | null;
  /** 「历史对决」板块数据（17:23 张老师：/vs/{id} 单 id 入口也要显示历史对决，
   *  未跑分前常显；选人/换人后 uids 跟随两侧卡片，VsHistFeed 自动重拉）。
   *  null=不渲染（VsScoreBoard 内嵌竞技场形态时由其自渲染，避免重复） */
  hist?: { rows: VsHistRow[]; total: number; pageSize: number } | null;
  /** 日期时间（21:06 张老师：竞技场音量按钮下方也要日期+分割线，与对决页同款
   *  ——由服务端算好传入，客户端组件水合零冲突） */
  dateStr?: string;
}) {
  const [left, setLeft] = useState<VsPickPlayer | null>(initialLeft);
  const [right, setRight] = useState<VsPickPlayer | null>(initialRight);
  const [sndOn, setSndOn] = useState(true); // SSR 无 localStorage，挂载后读回真值
  const [matching, setMatching] = useState(false); // 「匹配对手」请求进行中
  // 双方就位后的即时预测评价（十轮 14:38 张老师：匹配成功后立刻出现预测评价）——
  // /api/vs/pre 与对决页战前预测同源；null=未就位或加载中（显示金气泡「请双方选手就位」）
  const [pre, setPre] = useState<{ text: string; tone: PreTone } | null>(null);
  const preSeq = useRef(0); // 竞态：仅最后一次请求生效
  const both = left !== null && right !== null;
  // 单边有玩家：按钮变「匹配对手」（2026-11-11 张老师），自动补一个
  // 与登录者全国排名 ±50 的对手到空位；两边全空按钮置灰（文案同「匹配对手」）
  const one = !both && (left !== null || right !== null);

  // URL 实时同步（五轮 13:38 张老师：每换一个人 URL 就实时变化）：
  //   双卡 /vs/{l}/{r} · 只左 /vs/{l} · 只右 /vs?/{r} · 全空 /vs。
  // 只右用查询串占位（十轮 14:11 张老师定）：实测 /vs?/{r} 不被 Next 规范化，
  // 刷新保真（双斜杠 /vs//{r} 会被 308 吃掉，弃用）；replaceState 纯客户端
  // 无服务端往返，Next 16 铁律：原样传回 history.state。
  useEffect(() => {
    const l = left?.id;
    const r = right?.id;
    const target =
      l && r ? `/vs/${l}/${r}` : l ? `/vs/${l}` : r ? `/vs?/${r}` : "/vs";
    const cur = window.location.pathname + window.location.search;
    if (cur !== target) {
      window.history.replaceState(window.history.state, "", target);
    }
  }, [left, right]);

  useEffect(() => {
    try {
      setSndOn(localStorage.getItem("vs_snd") !== "0");
    } catch {}
  }, []);

  // 分割线/历史板块宽度（21:06 张老师：竞技场也要日期+分割线，与对决页同款）
  // ——同 VsScoreBoard fit 口径：测两侧 .vs_panel（空位问号盒同为 .vs_panel）
  // 的视觉跨度（收拢 translateX 含在 rect 内），写进分割线与板块 wrapper；
  // 移动端清空回全宽；换人/选人卡片宽恒定不重测也无妨，resize 重算。
  const [heroW, setHeroW] = useState<number | null>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dividerRef.current;
    if (!el) return;
    const fit = () => {
      // ⚠️ 不能用 el.closest——分割线是 #vs_pick_hero 的**兄弟**节点（挂在其后），
      // closest 只走祖先链；本页唯一实例，直接全局取
      const hero = document.getElementById("vs_pick_hero");
      const panels = hero?.querySelectorAll<HTMLElement>(".vs_panel");
      if (!hero || !panels || panels.length < 2) return;
      if (window.matchMedia("(max-width: 768px)").matches) {
        el.style.width = "";
        setHeroW(null);
        return;
      }
      const l = panels[0].getBoundingClientRect();
      const r = panels[panels.length - 1].getBoundingClientRect();
      el.style.width = `${Math.round(r.right - l.left)}px`;
      setHeroW(Math.round(r.right - l.left));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [left, right]);

  // 双方就位 → 立刻拉赛前预测（十轮 14:38 张老师：匹配成功后 URL 已更新，
  // 预测评价要**马上**出现，不等跳转对决页）。未就位/换人清空即回金气泡。
  // setState 只发生在异步回调里，规避 set-state-in-effect。
  useEffect(() => {
    const l = left?.id;
    const r = right?.id;
    if (!l || !r) {
      setPre(null);
      return;
    }
    const seq = ++preSeq.current;
    (async () => {
      try {
        const res = await fetch(`/api/vs/pre?l=${l}&r=${r}`);
        if (!res.ok) return;
        const d = (await res.json()) as { text: string; tone: PreTone };
        if (seq !== preSeq.current) return; // 已有更快的落位变化
        setPre({ text: d.text, tone: d.tone });
      } catch {
        /* 网络异常静默：保持「请双方选手就位」 */
      }
    })();
  }, [left, right]);

  const toggleSnd = () => {
    setSndOn((v) => {
      const next = !v;
      try {
        localStorage.setItem("vs_snd", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  /** 选定候选：先做落位校验，再拉卡片数据。
   *  自选口径（2026-11-11 张老师）：任一边都可以选自己；只有当另一边已经是自己
   *  （=两边同站自己）时才拦，提示「不能和自己比拼」。 */
  async function pick(slot: "left" | "right", u: SuggestUser) {
    const other = slot === "left" ? right : left;
    if (u.id === me.id && other?.id === me.id) {
      // 红色气泡（2026-11-11 张老师：拦截类提示用 error 态）
      toast("不能和自己比拼", "error");
      return;
    }
    if (other && other.id === u.id) {
      toast(slot === "left" ? "该玩家已在右侧" : "该玩家已在左侧");
      return;
    }
    try {
      const res = await fetch(`/api/vs/player?id=${u.id}`);
      if (!res.ok) {
        toast(res.status === 404 ? "没有找到该玩家" : "加载失败，请重试");
        return;
      }
      const { player } = (await res.json()) as { player: VsPickPlayer };
      if (slot === "left") setLeft(player);
      else setRight(player);
    } catch {
      toast("加载失败，请重试");
    }
  }

  function clearSlot(slot: "left" | "right") {
    if (slot === "left") setLeft(null);
    else setRight(null);
  }

  /** 匹配对手（2026-11-11 21:46 张老师定稿口径）：单边有玩家时点「匹配对手」——
   *  服务端池子＝高级 STNB ±5% 且全国排名 ±10 的玩家随机挑一人，池内无人则
   *  两维度同步扩大（±10%/±20 名……）直到找到；无论请求多快都把按钮置灰停留
   *  随机 1~3 秒（「匹配中」+ 转圈），到点再出人（七轮 13:28 口径）。 */
  async function matchOpponent() {
    if (matching) return;
    setMatching(true);
    try {
      const t0 = Date.now();
      const holdMs = 1000 + Math.floor(Math.random() * 2000); // 随机 1~3 秒
      // 场上已有玩家一并排除（不能匹配同站两边）
      const onBoard = left?.id ?? right?.id;
      const res = await fetch(`/api/vs/match${onBoard ? `?exclude=${onBoard}` : ""}`);
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          res.status === 404
            ? error === "no_exp_stnb"
              ? "你还没有高级 STNB 成绩，暂时无法匹配对手"
              : "你还没有全国排名，暂时无法匹配对手"
            : "匹配失败，请重试"
        );
        return;
      }
      const { id } = (await res.json()) as { id: number };
      const res2 = await fetch(`/api/vs/player?id=${id}`);
      if (!res2.ok) {
        toast("匹配失败，请重试");
        return;
      }
      const { player } = (await res2.json()) as { player: VsPickPlayer };
      // 剩余停留时间：请求再快也走完随机 1~3 秒的「匹配中」
      const remain = holdMs - (Date.now() - t0);
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      if (left === null) setLeft(player);
      else setRight(player);
    } catch {
      toast("匹配失败，请重试");
    } finally {
      setMatching(false);
    }
  }

  // 自己不在两边场上（两边全空或都换成了别人）→ 空位聚焦时推荐自己
  const selfOnBoard = left?.id === me.id || right?.id === me.id;
  const selfSuggest: SuggestUser = {
    id: me.id,
    chineseName: me.name,
    englishName: me.en,
    sex: me.sex,
  };

  return (
    <>
      <div id="vs_pick_hero">
      {left ? (
        <VsCard p={left} onSwap={() => clearSlot("left")} />
      ) : (
        <VsEmptySlot onPick={(u) => void pick("left", u)} suggestSelf={selfOnBoard ? null : selfSuggest} />
      )}
      {/* 中间列：完全复用 PK 页 .vs_vs 结构——.vs_scoreline（VS 战斗字标，两侧空
          占位 span 保住三列网格）+ .vs_action（按钮 + 喇叭开关正下方）。
          按钮三态：双方就位=黄色「一决胜负」进 /vs/{对手id}；单边有玩家=
          「匹配对手」（自动匹配全国排名 ±50 的对手填入空位）；两边全空=置灰。
          未就位时上方浮金色「请双方选手就位」气泡（绝对定位不占流内高度）。 */}
      <div className="vs_vs">
        <div className="vs_scoreline">
          {/* 中间列气泡（十轮 14:38）：未就位或预测加载中＝金气泡「请双方选手就位」；
              双方就位且预测已回＝按 tone 渲染真预测（与对决页战前预测同款卡片框）。
              .vs_pick_pre 绝对定位悬浮在 VS 字标上方，卸载/替换零布局位移 */}
          {(!both || !pre) && (
            <div className="vs_pre vs_pre_even vs_pick_pre" role="status">
              请双方选手就位
            </div>
          )}
          {both && pre && (
            <div className={`vs_pre vs_pre_${pre.tone} vs_pick_pre`} role="status">
              {pre.text}
            </div>
          )}
          <span aria-hidden="true" />
          {/* eslint-disable-next-line @next/next/no-img-element -- 固定静态资源 */}
          <img src="/icons/clash.png" alt="VS" width={96} height={102} draggable={false} />
          <span aria-hidden="true" />
        </div>
        <div className="vs_action">
          <button
            type="button"
            className="vs_fight"
            disabled={(!both && !one) || matching}
            onClick={() => {
              if (both) {
                // 对决交接（十轮 14:11 张老师：URL 不带 fight 参数——/vs/{l}/{r}
                // 即对决页，后台/直访为手动两段式；竞技场点「一决胜负」经
                // sessionStorage 标记交接，落地自动跑分，八轮 13:29 口径）。
                // 左右两卡即对决双方；整页跳转保证服务端重渲对决数据。
                if (left && right) {
                  // 交接标记改 cookie（17:24 张老师：落地瞬间历史闪现又消失——
                  // sessionStorage 方案 SSR 读不到，无法在首帧隐藏历史）：
                  // path=/vs 限定范围、10s 过期，对决页 SSR 与客户端都能读到
                  document.cookie = `vs_autorun=${Date.now()}; path=/vs; max-age=10; SameSite=Lax`;
                  window.location.assign(`/vs/${left.id}/${right.id}`);
                }
              } else if (one) {
                void matchOpponent();
              }
            }}
          >
            {matching ? (
              <>
                {/* 匹配中：置灰 + 钮内转圈（.vs_spin 复用 toast_spin 关键帧），
                    随机 1~3 秒后出人（七轮 13:28 张老师口径） */}
                <span className="vs_spin" aria-hidden="true" />
                匹配中
              </>
            ) : both ? (
              "一决胜负"
            ) : (
              "匹配对手"
            )}
          </button>
          <SndSwitch on={sndOn} onToggle={toggleSnd} />
        </div>
      </div>
      {right ? (
        <VsCard p={right} onSwap={() => clearSlot("right")} />
      ) : (
        <VsEmptySlot onPick={(u) => void pick("right", u)} suggestSelf={selfOnBoard ? null : selfSuggest} />
      )}
      </div>
      {/* 日期+分割线（21:06 张老师：竞技场音量按钮下方也要，与对决页同款——
          日期居中、分割线宽度与两侧卡片边缘平齐（fit 测量值），移动端全宽） */}
      {dateStr && (
        <>
          <span className="vs_date vs_pick_date">{dateStr}</span>
          <div className="vs_divider vs_pick_divider" ref={dividerRef} aria-hidden="true" />
        </>
      )}
      {/* 「历史对决」板块（17:23 张老师：/vs/{id} 单 id 入口、未跑分前常显；
          选人/换人后 uids 跟随两侧卡片自动重拉。至少一侧有人才渲染——全空
          没有发起者语义，板块整体摘除。21:06 张老师：宽度与分割线一致（同
          对决页口径，heroW 写进 wrapper 居中） */}
      {hist && (left?.id || right?.id) && (
        <div className="vs_hist_wrap" style={heroW ? { width: heroW } : undefined}>
          <VsHistBlock
            uid1={left?.id ?? 0}
            uid2={right?.id ?? 0}
            initial={hist.rows}
            total={hist.total}
            pageSize={hist.pageSize}
          />
        </div>
      )}
    </>
  );
}
