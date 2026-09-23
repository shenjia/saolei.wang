// 排行导航条（2008 编排：左侧榜别切换 + 右侧查找定位，2026-09-23 张老师要求；
// 2026-09-24 三轮调整：双输入框合并为单个圆角搜索框——矢量放大镜 + placeholder「姓名或ID」；
// 2026-09-24 四轮：去掉「查找」按钮——汉字输入防抖模糊匹配出推荐下拉（键盘上下选、回车确认），
// 唯一候选自动定位；通过自定义事件 ranking:locate 委托同页的 RankingFeed 执行定位）

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";

export type RankingView = "all" | "nf" | "grow" | "area" | "click" | "world";

const TABS: { key: RankingView; label: string; href: string }[] = [
  { key: "all", label: "雷界排行", href: "/ranking" },
  { key: "nf", label: "NF", href: "/ranking?view=nf" },
  { key: "grow", label: "进步", href: "/grow" },
  { key: "area", label: "地区", href: "/area" },
  { key: "click", label: "人气", href: "/click" },
  { key: "world", label: "世界", href: "/ranking?view=world" },
];

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

export function RankingNav({ current, by }: { current: RankingView; by?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<SuggestUser[] | null>(null);
  const [active, setActive] = useState(0); // 键盘上下键游标
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效

  // 数字输入也出推荐（按 ID 前缀实时匹配玩家）；下拉项的次级文字数字模式显示 ID
  const numeric = /^\d+$/.test(q.trim());

  // 事件委托：RankingFeed 在同页监听并执行定位（页内滚动/拉取/跳 whereami）
  function locate(id: number) {
    window.dispatchEvent(new CustomEvent("ranking:locate", { detail: { id } }));
  }

  // 防抖 250ms 模糊推荐（setState 只发生在异步回调里，规避 set-state-in-effect）
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
        // 唯一候选 → 自动开始查询（张老师要求：确定只有一个选择即触发，无需输完姓名）
        if (list.length === 1) {
          setUsers(null);
          locate(list[0].id);
        }
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

  function submit(kw: string) {
    const key = kw.trim();
    if (!key) return;
    // 纯数字按 ID，其余按姓名——ID 走轻量事件定位，姓名让服务端反查后整页导航
    if (/^\d+$/.test(key)) {
      const id = parseInt(key, 10);
      if (id > 0) locate(id);
    } else {
      locateName(key);
    }
  }

  async function locateName(name: string) {
    // 先轻量探测（json）：无成绩/不存在 → 全局居中气泡提示，不跳转
    const qs = new URLSearchParams({ name, format: "json" });
    if (by) qs.set("by", by);
    if (current === "nf") qs.set("view", "nf");
    try {
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const { page } = (await res.json()) as { page: number };
        if (page <= 0) {
          toast("该玩家未加入排行榜（暂无成绩）");
          return;
        }
      }
    } catch {
      /* 探测失败走导航兜底 */
    }
    const nav = new URLSearchParams({ name });
    if (by) nav.set("by", by);
    if (current === "nf") nav.set("view", "nf");
    // 姓名需服务端反查 id（whereami 302 会带 page+hl 回来，落地即高亮），走整页导航
    router.push(`/ranking/whereami?${nav}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (users === null || users.length === 0) {
      if (e.key === "Enter") submit(q);
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
        locate(pick.id);
      }
    } else if (e.key === "Escape") {
      setUsers(null);
    }
  }

  return (
    <div className="ranking_nav">
      <div className="ranking_tabs">
        {TABS.map((t) =>
          t.key === current ? (
            <span key={t.key} className="current">
              {t.label}
            </span>
          ) : (
            <Link key={t.key} href={t.href}>
              {t.label}
            </Link>
          )
        )}
      </div>
      {(current === "all" || current === "nf") && (
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
              title="输入姓名或用户 ID，定位到排行榜中的位置"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="off"
            />
          </span>
          {users !== null && users.length > 0 && (
            <ul className="goto_suggest">
              {users.map((u, i) => (
                <li key={u.id} className={i === active ? "active" : ""}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      setUsers(null);
                      setQ(u.chineseName);
                      locate(u.id);
                    }}
                  >
                    <em>{u.chineseName}</em>
                    {/* 数字模式次级文字显示 ID（用户按 ID 找人时姓名才是补充信息），
                        其余显示英文名 */}
                    <span>{numeric ? `ID ${u.id}` : u.englishName || null}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
