"use client";

// /vs 对决选择页（2026-11-11 张老师需求）：
//   · 左侧放自己（初始数据由服务端传入），右侧空位 = 问号头像 + 搜索框
//     （同排行搜索：防抖 250ms 调 /api/ranking/search，下拉键盘上下选、回车/点击选定；
//     空内容聚焦且自己不在场上时下拉直接推荐自己——四轮 11:23）；
//   · 选定对手后拉 /api/vs/player 渲染该玩家卡片 + 实力雷达
//     （卡片结构与 /vs/[id] 的 VsPanel 完全同源）；
//   · 有玩家的卡片右上角圆角处一律出深灰 X 圆形按钮（未选定对手时我方卡片也有，
//     二轮 10:45 张老师：可以两边全空），hover 出上方气泡「换人」，
//     点击清空该卡片回到「问号头像 + 搜索框」空位态（与右侧初始 UI 完全一致）；
//   · 中间列完全复用 PK 页（/vs/[id]）布局：.vs_vs（.vs_scoreline VS 战斗字标 +
//     .vs_action 黄色对决按钮 + 喇叭音效开关）——音效开关与 PK 页共用
//     localStorage「vs_snd」；双方就位前按钮置灰，就位后点「开始对决」进入 /vs/{对手id}。
// 约束：右侧不能选自己（不能和自己比拼）；同一玩家不能同时站两边。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "./Toast";
import { AvatarCell, TitleBadge } from "./Cells";
import { DefaultAvatar } from "./DefaultAvatar";
import { RadarChart } from "./RadarChart";
import { AREA_OVERSEAS, areaDisplay } from "@/lib/config";
import type { RadarPoint } from "@/lib/radar";

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
    <div className="box vs_panel vs_pick_empty">
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

export function VsPickArena({ me }: { me: VsPickPlayer }) {
  const router = useRouter();
  const [left, setLeft] = useState<VsPickPlayer | null>(me);
  const [right, setRight] = useState<VsPickPlayer | null>(null);
  const [sndOn, setSndOn] = useState(true); // SSR 无 localStorage，挂载后读回真值
  const both = left !== null && right !== null;

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

  /** 选定候选：先做落位校验（不能和自己比拼 / 不能同站两边），再拉卡片数据 */
  async function pick(slot: "left" | "right", u: SuggestUser) {
    const other = slot === "left" ? right : left;
    if (slot === "right" && u.id === me.id) {
      toast("不能和自己比拼");
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

  // 自己不在两边场上（两边全空或都换成了别人）→ 空位聚焦时推荐自己
  const selfOnBoard = left?.id === me.id || right?.id === me.id;
  const selfSuggest: SuggestUser = {
    id: me.id,
    chineseName: me.name,
    englishName: me.en,
    sex: me.sex,
  };

  return (
    <div id="vs_pick_hero">
      {left ? (
        <VsCard p={left} onSwap={() => clearSlot("left")} />
      ) : (
        <VsEmptySlot onPick={(u) => void pick("left", u)} suggestSelf={selfOnBoard ? null : selfSuggest} />
      )}
      {/* 中间列：完全复用 PK 页 .vs_vs 结构——.vs_scoreline（VS 战斗字标，两侧空
          占位 span 保住三列网格）+ .vs_action（黄色「开始对决」+ 喇叭开关正下方）。
          双方未就位按钮置灰，就位后进入 /vs/{对手id}。 */}
      <div className="vs_vs">
        <div className="vs_scoreline">
          <span aria-hidden="true" />
          {/* eslint-disable-next-line @next/next/no-img-element -- 固定静态资源 */}
          <img src="/icons/clash.png" alt="VS" width={96} height={102} draggable={false} />
          <span aria-hidden="true" />
        </div>
        <div className="vs_action">
          <button
            type="button"
            className="vs_fight"
            disabled={!both}
            onClick={() => right && router.push(`/vs/${right.id}`)}
          >
            开始对决
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
  );
}
