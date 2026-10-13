// 论坛页头搜索框（2026-09-26 张老师要求：右上角按关键字搜帖子——标题或人名）
// 样式与交互完全复用排行页 goto_form 语言（圆角胶囊 + 放大镜 + 防抖人名推荐下拉）；
// 差异在提交语义：排行是「定位到行」，这里是「回车跳 /bbs?q=关键字」过滤主题列表。
// 输入即出人名推荐（复用 /api/ranking/search）：点选/回车选中某位玩家 = 按该人名精确搜索；
// 纯标题词直接回车即搜（不打扰，无自动跳转）。

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

export function BbsSearch({ initialQ = "" }: { initialQ?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [users, setUsers] = useState<SuggestUser[] | null>(null);
  const [active, setActive] = useState(0); // 键盘上下键游标
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效

  const kw = q.trim();

  // 防抖 250ms 人名模糊推荐（同排行页：setState 只发生在异步回调里，规避 set-state-in-effect；
  // 清空输入时下拉由渲染条件 kw!=="" 隐藏，无需同步 setState）
  useEffect(() => {
    const kw = q.trim();
    if (!kw) {
      reqSeq.current++; // 使在途请求失效
      return;
    }
    const seq = ++reqSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(kw)}`);
        if (!res.ok) return;
        const { users: list } = (await res.json()) as { users: SuggestUser[] };
        if (seq !== reqSeq.current) return; // 已有更新的输入
        setUsers(list);
        setActive(0);
      } catch {
        /* 网络异常静默：回车提交仍可用 */
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

  function search(keyword: string) {
    const key = keyword.trim();
    if (!key) return;
    router.push(`/bbs?q=${encodeURIComponent(key)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (users === null || users.length === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        search(q);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % users.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + users.length) % users.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = users[active];
      if (pick) {
        setUsers(null);
        setQ(pick.chineseName);
        search(pick.chineseName);
      }
    } else if (e.key === "Escape") {
      setUsers(null);
    }
  }

  return (
    <div className="goto_form bbs_search" ref={boxRef}>
      <span className="goto_search">
        <svg className="goto_icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="9.4" y1="9.4" x2="13" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={q}
          maxLength={30}
          placeholder="标题或人名"
          title="输入关键字搜索主题（匹配标题或作者），回车提交"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
      </span>
      {users !== null && kw !== "" && (
        <ul className="goto_suggest">
          {users.length === 0 ? (
            <li className="goto_empty">没有匹配的玩家，将按标题搜索</li>
          ) : (
            users.map((u, i) => (
              <li key={u.id} className={i === active ? "active" : ""}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    setUsers(null);
                    setQ(u.chineseName);
                    search(u.chineseName);
                  }}
                >
                  <em>{u.chineseName}</em>
                  <span>{u.englishName || `ID ${u.id}`}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
