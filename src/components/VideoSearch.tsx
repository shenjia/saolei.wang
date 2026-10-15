// 录像页搜索框（2026-10-15 张老师需求：右侧排序 tabs 去掉，换搜索框）：
// 可搜索「玩家」或「时间成绩」——输中文出模糊推荐下拉（与排行搜索体验一致，复用
// /api/ranking/search），选中即筛该玩家上传的录像；输数字（秒）出「时间成绩」项，
// 匹配所有显示相同（±5ms 舍入窗）的成绩；纯整数同时探测同 ID 玩家（排行同款）。
// 交互语言对齐 RankingNav：防抖 250ms、键盘上下选、回车确认、唯一中文候选自动筛选、
// 选中即收起（pickedRef 抑制随后那轮同名推荐）、点击外部收起。
// 已有筛选（玩家/时间）时聚焦或清空输入 → 下拉出「清除搜索」。
// 筛选与级别/排序列正交：跳转保留 level 与 order，玩家/时间互斥（二选一）。

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseVideoTimeWindow, VIDEO_TIME_INPUT_RE } from "@/lib/config";
import { scoreTime } from "@/lib/format";
import { buildUrl } from "./Pager";
import { toast } from "./Toast";

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

/** 下拉项：玩家候选 / 时间成绩搜索 / 清除搜索（空数组=无匹配，渲染空态文案） */
type Item =
  | { kind: "user"; user: SuggestUser }
  | { kind: "time"; value: string }
  | { kind: "clear" };

export function VideoSearch({
  level,
  order,
  author,
  authorName,
  time,
}: {
  level: string;
  /** 当前排序（跳转时保留；默认排序 id 不进 URL） */
  order: string;
  /** 当前玩家筛选（用户 id） */
  author?: number;
  /** 当前玩家筛选的姓名（搜索框回显用） */
  authorName?: string;
  /** 当前时间成绩搜索输入（回显用） */
  time?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(authorName ?? time ?? "");
  const [items, setItems] = useState<Item[] | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效
  // 选中推荐项时会把输入框写成该项姓名，q 变化会立刻触发新一轮推荐 → 下拉在跳转后又冒出来
  // （排行同款：选中即收起）。记下刚选中的关键字，跳过这一轮。
  const pickedRef = useRef<string | null>(null);
  // 用户是否实际输入过：带筛选进页时输入框有回显值，但不应自动弹推荐下拉
  const dirtyRef = useRef(false);

  const hasFilter = !!author || !!time;

  const kw = q.trim();
  const isTimeInput = VIDEO_TIME_INPUT_RE.test(kw);
  const isPureInt = /^\d+$/.test(kw);

  /** 时间项的展示值（归一化，如 37 → 37.00） */
  function timeItem(): Item {
    const win = parseVideoTimeWindow(kw)!;
    return { kind: "time", value: scoreTime(win[0] + 5) };
  }

  // 防抖 250ms：时间项 / 数字输入的 ID 玩家 / 中文模糊玩家（setState 只发生在异步回调里）
  useEffect(() => {
    if (!dirtyRef.current) return; // 回显值不触发推荐（仅用户输入过才出下拉）
    if (!kw) {
      reqSeq.current++; // 使在途请求失效
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
      // 时间格式输入：小数无玩家候选，直接给时间项；纯整数另探测同 ID 玩家
      if (isTimeInput && !isPureInt) {
        setItems([timeItem()]);
        setActive(0);
        return;
      }
      try {
        const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(kw)}&limit=8`);
        if (!res.ok) return;
        const { users } = (await res.json()) as { users: SuggestUser[] };
        if (seq !== reqSeq.current) return;
        const list: Item[] = users.map((u) => ({ kind: "user" as const, user: u }));
        if (isTimeInput) list.push(timeItem());
        setItems(list);
        setActive(0);
        // 唯一中文候选 → 自动筛选（排行同款：确定只有一个选择即触发）；
        // 数字输入始终展示候选（用户可能还要继续输位数/小数）
        if (users.length === 1 && !isTimeInput) {
          pickUser(users[0]);
        }
      } catch {
        /* 网络异常静默：回车提交仍可用 */
      }
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

  /** 跳转 URL：保留级别与排序，玩家/时间互斥 */
  function nav(params: { author?: number; time?: string }) {
    router.push(
      buildUrl("/video", {
        level,
        order: order === "id" ? undefined : order,
        author: params.author,
        time: params.time,
        page: undefined,
      })
    );
  }

  function pickUser(u: SuggestUser) {
    pickedRef.current = u.chineseName.trim();
    setItems(null);
    setQ(u.chineseName);
    nav({ author: u.id });
  }

  function pickTime(value: string) {
    pickedRef.current = value;
    setItems(null);
    setQ(value);
    nav({ time: value });
  }

  function pickClear() {
    pickedRef.current = null;
    setItems(null);
    setQ("");
    nav({});
  }

  /** 回车无候选时提交：时间格式→时间搜索；文本→玩家精确反查（找不到弹气泡） */
  async function submit(text: string) {
    const key = text.trim();
    if (!key) return;
    if (VIDEO_TIME_INPUT_RE.test(key)) {
      const win = parseVideoTimeWindow(key);
      if (win) pickTime(scoreTime(win[0] + 5));
      return;
    }
    try {
      const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(key)}&limit=8`);
      if (res.ok) {
        const { users } = (await res.json()) as { users: SuggestUser[] };
        const hit = users.find((u) => u.chineseName === key) ?? users[0];
        if (hit) {
          pickUser(hit);
          return;
        }
      }
    } catch {
      /* 网络异常走下方气泡 */
    }
    toast("没有找到符合条件的玩家");
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
      else if (item.kind === "time") pickTime(item.value);
      else if (item.kind === "clear") pickClear();
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
          placeholder="玩家或成绩"
          title="输入玩家姓名筛选其上传的录像，或输入时间成绩（秒，如 37.29）查找相同成绩的所有录像"
          onChange={(e) => {
            dirtyRef.current = true;
            setQ(e.target.value);
            // 清空输入且有筛选 → 出「清除搜索」项（无筛选则收起）
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
            <li className="goto_empty">没有找到符合条件的玩家</li>
          ) : (
            items.map((item, i) => {
              const cls = i === active ? "active" : "";
              if (item.kind === "user") {
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
              }
              if (item.kind === "time") {
                return (
                  <li key="time" className={cls || undefined}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pickTime(item.value)}
                    >
                      <em>时间成绩 {item.value}</em>
                      <span>找相同成绩的录像</span>
                    </button>
                  </li>
                );
              }
              // clear
              return (
                <li key="clear" className={cls || undefined}>
                  <button type="button" onMouseEnter={() => setActive(i)} onClick={pickClear}>
                    <em>清除搜索</em>
                    <span>{authorName ?? time}</span>
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
