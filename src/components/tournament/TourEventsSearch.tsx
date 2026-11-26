// 比赛详情页「动态」板块按玩家搜索框（2026-11-26 张老师需求）。
// 样式与交互完全复用排行页搜索框（RankingNav 的 .goto_form/.goto_search/.goto_suggest
// + /api/ranking/search）：250ms 防抖模糊推荐、纯数字按 ID 推荐、键盘上下选/回车确认、
// 唯一中文候选自动选中、选中即收起（pickedRef 抑制回弹）、点击外部收起。
// 与排行页「定位到榜单行」不同，这里选中玩家=把动态列表筛成该玩家的动态
// （URL ?eauthor=<uid>，服务端查询层过滤，翻页/加载更多/录像区搜索全链路透传）。

"use client";

import { useEffect, useRef, useState } from "react";
import { toast, toastLoading } from "@/components/Toast";

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

type Item = { kind: "user"; user: SuggestUser } | { kind: "clear" };

export function TourEventsSearch({
  uid,
  name,
  onPick,
}: {
  /** 当前筛选的玩家 id（无筛选为 undefined） */
  uid?: number;
  /** 当前筛选玩家的姓名（SSR 回显；空串=无筛选或用户不存在） */
  name?: string;
  /** 选中玩家 / 清除筛选（由动态壳写 URL 并触发 RSC 换数） */
  onPick: (user: { id: number; chineseName: string } | null) => void;
}) {
  const [q, setQ] = useState(name ?? "");
  const [items, setItems] = useState<Item[] | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效
  const pickedRef = useRef<string | null>(null); // 选中后抑制同名推荐（排行同款）
  const dirtyRef = useRef(false); // 带筛选进页的输入是回显，不应自动弹下拉

  const kw = q.trim();
  const numeric = /^\d+$/.test(kw);
  const hasFilter = !!uid;
  const emptyMsg = numeric ? `没有找到ID为${kw}的玩家` : "没有找到符合条件的玩家";

  async function fetchUsers(k: string): Promise<SuggestUser[]> {
    try {
      const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(k)}&limit=8`);
      if (!res.ok) return [];
      const { users } = (await res.json()) as { users: SuggestUser[] };
      return users;
    } catch {
      return [];
    }
  }

  // 250ms 防抖模糊推荐（setState 只发生在异步回调里，规避 set-state-in-effect）
  useEffect(() => {
    if (!dirtyRef.current) return;
    if (!kw) {
      reqSeq.current++;
      pickedRef.current = null;
      return;
    }
    if (pickedRef.current === kw) {
      reqSeq.current++;
      return;
    }
    pickedRef.current = null;
    const seq = ++reqSeq.current;
    const timer = setTimeout(async () => {
      const users = await fetchUsers(kw);
      if (seq !== reqSeq.current) return;
      setItems(users.map((user) => ({ kind: "user" as const, user })));
      setActive(0);
      // 排行同款：唯一中文候选直接选中（数字输入始终列候选，用户可能还在输位数）
      if (users.length === 1 && !numeric) pickUser(users[0]);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // 点击外部收起下拉
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setItems(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  function pickUser(u: SuggestUser) {
    pickedRef.current = u.chineseName.trim();
    setItems(null);
    setQ(u.chineseName);
    toastLoading(); // 与排行/录像搜索一致：跳转等待气泡，URL 变化后自动渐隐
    onPick({ id: u.id, chineseName: u.chineseName });
  }

  function pickClear() {
    pickedRef.current = null;
    setItems(null);
    setQ("");
    dirtyRef.current = false;
    onPick(null);
  }

  /** 回车且无候选：按 ID 或姓名精确反查一次（排行 locateName / 录像 findUser 同口径） */
  async function submit(text: string) {
    const key = text.trim();
    if (!key) return;
    const users = await fetchUsers(key);
    const hit = numeric
      ? users.find((u) => u.id === parseInt(key, 10))
      : (users.find((u) => u.chineseName === key) ?? users[0]);
    if (hit) pickUser(hit);
    else toast(emptyMsg);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (items === null || items.length === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit(q);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (!item) return;
      if (item.kind === "user") pickUser(item.user);
      else pickClear();
    } else if (e.key === "Escape") {
      setItems(null);
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
          placeholder="姓名或ID"
          title="输入玩家姓名或用户 ID，只看该玩家在本比赛中的动态"
          onChange={(e) => {
            dirtyRef.current = true;
            setQ(e.target.value);
            if (!e.target.value.trim()) {
              setItems(hasFilter ? [{ kind: "clear" }] : null);
              setActive(0);
            }
          }}
          onFocus={() => {
            if (!q.trim() && hasFilter) {
              setItems([{ kind: "clear" }]);
              setActive(0);
            }
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
      </span>
      {items !== null && (
        <ul className="goto_suggest">
          {items.length === 0 ? (
            <li className="goto_empty">{emptyMsg}</li>
          ) : (
            items.map((item, i) => {
              const cls = i === active ? "active" : "";
              if (item.kind === "clear") {
                return (
                  <li key="clear" className={cls || undefined}>
                    <button type="button" onMouseEnter={() => setActive(i)} onClick={pickClear}>
                      <em>清除搜索</em>
                      <span>{name}</span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={`u${item.user.id}`} className={cls || undefined}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pickUser(item.user)}
                  >
                    <em>{item.user.chineseName}</em>
                    <span>{item.user.englishName || `ID ${item.user.id}`}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
