"use client";

// /vs 对决选择页（2026-11-11 张老师需求）：
//   · 左侧放自己（初始数据由服务端传入），右侧空位 = 问号头像 + 搜索框
//     （同排行搜索：防抖 250ms 调 /api/ranking/search，下拉键盘上下选、回车/点击选定）；
//   · 选定对手后拉 /api/vs/player 渲染该玩家卡片 + 实力雷达
//     （卡片结构与 /vs/[id] 的 VsPanel 完全同源）；
//   · 双方就位后卡片右上角出亮灰 X 圆形按钮，hover 变黄出气泡「换人」，
//     点击清空该卡片回到「问号头像 + 搜索框」空位态（与右侧初始 UI 完全一致）。
// 约束：右侧不能选自己（不能和自己比拼）；同一玩家不能同时站两边。

import { useEffect, useRef, useState } from "react";
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

/** 搜索框（同排行搜索交互）：防抖推荐下拉 + 键盘导航；选定即回调并清空输入 */
function VsSearch({ onPick }: { onPick: (u: SuggestUser) => void }) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<SuggestUser[] | null>(null);
  const [active, setActive] = useState(0); // 键盘上下键游标
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效

  const kw = q.trim();
  const numeric = /^\d+$/.test(kw);
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
          placeholder="搜索对手（姓名/ID）"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
      </span>
      {users !== null && kw !== "" && (
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
                  {/* 对决页无榜别上下文，次级文字显示 ID */}
                  <span>ID {u.id}</span>
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
 *  onSwap 提供时（双方就位）右上角渲染「换人」X 按钮。 */
function VsCard({ p, onSwap }: { p: VsPickPlayer; onSwap?: () => void }) {
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

/** 空位：问号头像占位 + 搜索框（刚进入页面时右侧的 UI；换人清空后回到同一形态） */
function VsEmptySlot({ onPick }: { onPick: (u: SuggestUser) => void }) {
  return (
    <div className="box vs_panel vs_pick_empty">
      {/* eslint-disable-next-line @next/next/no-img-element -- 本地静态占位图 */}
      <img className="vs_pick_q" src="/images/common/avatar.png" alt="?" />
      <VsSearch onPick={onPick} />
    </div>
  );
}

export function VsPickArena({ me }: { me: VsPickPlayer }) {
  const [left, setLeft] = useState<VsPickPlayer | null>(me);
  const [right, setRight] = useState<VsPickPlayer | null>(null);
  const both = left !== null && right !== null;

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

  return (
    <div id="vs_pick_hero">
      {left ? (
        <VsCard p={left} onSwap={both ? () => clearSlot("left") : undefined} />
      ) : (
        <VsEmptySlot onPick={(u) => void pick("left", u)} />
      )}
      {right ? (
        <VsCard p={right} onSwap={both ? () => clearSlot("right") : undefined} />
      ) : (
        <VsEmptySlot onPick={(u) => void pick("right", u)} />
      )}
    </div>
  );
}
