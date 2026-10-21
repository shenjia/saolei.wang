// 录像页搜索框（2026-10-15 张老师需求：右侧排序 tabs 去掉，换搜索框）：
// 可搜索「玩家」或「时间成绩」——输中文出模糊推荐下拉（与排行搜索体验一致，复用
// /api/ranking/search），选中即筛该玩家上传的录像；输数字（秒）出「时间成绩」项，
// 匹配所有显示相同（±5ms 舍入窗）的成绩；纯整数同时探测同 ID 玩家（排行同款）。
// 2026-10-16 张老师需求：纯整数额外探测同 ID 录像（/api/video/lookup），命中出
// 「录像 #ID（级别 · 上传者）」项，回车/点击直达 /video/<id>；屏蔽录像视同不存在。
// 2026-10-20 张老师需求：搜索支持 3BV——纯整数输入额外出「3BV N」项（精确匹配
// 该 3BV 值的所有录像），与时间成绩项并列（纯整数语义多重：ID 录像/同 ID 玩家/
// 3BV/时间成绩，全部列出让用户选）。
// 交互语言对齐 RankingNav：防抖 250ms、键盘上下选、回车确认、唯一中文候选自动筛选、
// 选中即收起（pickedRef 抑制随后那轮同名推荐）、点击外部收起。
// 已有筛选（玩家/时间/3BV）时聚焦或清空输入 → 下拉出「清除搜索」。
// 筛选与级别/排序列正交：跳转保留 level 与 order，玩家/时间/3BV 互斥（三选一）。
// 2026-10-20（张老师需求）：① NF 开关态透传——跳转保留 nf=1（NF 筛选与搜索正交）；
// ② scope="user" 用户主页录像版块模式——右上角上传按钮换搜索框（张老师需求），
// 作者锁定为该主页用户（不可搜玩家），仅支持时间成绩/3BV/录像 ID 三种查询；
// 跳转回本主页 URL（/user/{id}?time=…），不动 /video。

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LEVEL_NAMES,
  parseVideoTimeWindow,
  parseVideo3bv,
  VIDEO_TIME_INPUT_RE,
  type Level,
} from "@/lib/config";
import { scoreTime } from "@/lib/format";
import { buildUrl } from "./Pager";
import { toast } from "./Toast";

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

/** ID 探测命中的录像摘要（/api/video/lookup） */
interface SuggestVideo {
  id: number;
  level: string;
  /** 成绩（毫秒，老录像可能缺失） */
  realTime: number | null;
  chineseName: string;
}

/** 下拉项：玩家候选 / 录像 ID 直达 / 时间成绩搜索 / 3BV 搜索 / 清除搜索（空数组=无匹配，渲染空态文案） */
type Item =
  | { kind: "user"; user: SuggestUser }
  | { kind: "video"; video: SuggestVideo }
  | { kind: "time"; value: string }
  | { kind: "3bv"; value: number }
  | { kind: "clear" };

export function VideoSearch({
  level,
  order,
  author,
  authorName,
  time,
  bv,
  nf,
  scope,
  userId,
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
  /** 当前 3BV 搜索输入（回显用，2026-10-20） */
  bv?: string;
  /** NF 筛选开关（2026-10-20）：跳转保留 nf=1 */
  nf?: boolean;
  /** 作用域（2026-10-20）："list"=默认 /video 列表页；"user"=用户主页录像版块
   *  （作者锁定，只支持 成绩/3BV/ID 三种查询，跳转回本主页 URL） */
  scope?: "list" | "user";
  /** scope=user：主页用户 id（跳转 /user/{id}）与显示名（清除搜索回显） */
  userId?: number;
}) {
  const router = useRouter();
  const isUser = scope === "user";
  const [q, setQ] = useState(
    isUser ? (time ?? (bv != null ? `3BV ${bv}` : "")) : authorName ?? time ?? (bv != null ? `3BV ${bv}` : "")
  );
  const [items, setItems] = useState<Item[] | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效
  // 选中推荐项时会把输入框写成该项姓名，q 变化会立刻触发新一轮推荐 → 下拉在跳转后又冒出来
  // （排行同款：选中即收起）。记下刚选中的关键字，跳过这一轮。
  const pickedRef = useRef<string | null>(null);
  // 用户是否实际输入过：带筛选进页时输入框有回显值，但不应自动弹推荐下拉
  const dirtyRef = useRef(false);

  const hasFilter = (isUser ? false : !!author) || !!time || bv != null;

  /** 同 ID 玩家候选（user 模式不调用）与同 ID 录像探测的薄封装（2026-10-20 user 模式引入） */
  async function fetchUsers(kw: string): Promise<SuggestUser[]> {
    const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(kw)}&limit=8`);
    if (!res.ok) return [];
    const { users } = (await res.json()) as { users: SuggestUser[] };
    return users;
  }
  async function fetchVideoById(id: string): Promise<SuggestVideo | null> {
    const res = await fetch(`/api/video/lookup?id=${id}`);
    if (!res.ok) return null;
    const { video } = (await res.json()) as { video: SuggestVideo | null };
    return video;
  }

  const kw = q.trim();
  const isTimeInput = VIDEO_TIME_INPUT_RE.test(kw);
  const isPureInt = /^\d+$/.test(kw);

  /** 时间项的展示值（归一化，如 37 → 37.00） */
  function timeItem(): Item {
    const win = parseVideoTimeWindow(kw)!;
    return { kind: "time", value: scoreTime(win[0] + 5) };
  }

  /** 3BV 项（2026-10-20）：输入是合法 3BV 整数时给出 */
  function bvItem(): Item | null {
    const n = parseVideo3bv(kw);
    return n != null ? { kind: "3bv", value: n } : null;
  }

  // 防抖 250ms：时间项 / 数字输入的 ID 玩家+ID 录像 / 中文模糊玩家（setState 只发生在异步回调里）
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
      // 时间格式输入：小数无玩家候选，直接给时间项；纯整数另探测同 ID 玩家/录像
      if (isTimeInput && !isPureInt) {
        setItems([timeItem()]);
        setActive(0);
        return;
      }
      // 纯整数：并行探测同 ID 玩家（排行同款；user 模式作者锁定跳过）与同 ID 录像
      if (isPureInt) {
        // user 模式玩家候选恒空（作者锁定），跳过 ranking/search 请求
        const users: SuggestUser[] = isUser
          ? []
          : await fetchUsers(kw).catch(() => []);
        const video = await fetchVideoById(kw).catch(() => null);
        if (seq !== reqSeq.current) return;
        // ID 录像置顶（整数输入时它是最高意图），同 ID 玩家、3BV 与时间项随后
        const list: Item[] = [];
        if (video) list.push({ kind: "video", video });
        list.push(...users.map((u) => ({ kind: "user" as const, user: u })));
        const bi = bvItem();
        if (bi) list.push(bi);
        if (isTimeInput) list.push(timeItem());
        setItems(list);
        setActive(0);
        // 数字输入始终展示候选（用户可能还要继续输位数/小数），不自动筛选
        return;
      }
      if (isUser) {
        // 用户主页模式：作者已锁定，中文输入无玩家语义 → 空态（回车提示）
        setItems([]);
        setActive(0);
        return;
      }
      try {
        const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(kw)}&limit=8`);
        if (!res.ok) return;
        const { users } = (await res.json()) as { users: SuggestUser[] };
        if (seq !== reqSeq.current) return;
        const list: Item[] = users.map((u) => ({ kind: "user" as const, user: u }));
        setItems(list);
        setActive(0);
        // 唯一中文候选 → 自动筛选（排行同款：确定只有一个选择即触发）
        if (users.length === 1) {
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

  /** 跳转 URL：列表模式保留级别/排序/作者筛选，玩家/时间/3BV 互斥（三选一），
   *  NF 开关态正交保留（2026-10-20）；user 模式跳回本主页 /user/{id}
   *  （作者锁定，level/order/nf 由主页壳的 URL 状态承接） */
  function nav(params: { author?: number; time?: string; bv?: string }) {
    if (isUser) {
      router.push(
        buildUrl(`/user/${userId}`, {
          time: params.time,
          "3bv": params.bv,
          page: undefined,
        })
      );
      return;
    }
    router.push(
      buildUrl("/video", {
        level,
        order: order === "id" ? undefined : order,
        author: params.author,
        time: params.time,
        "3bv": params.bv,
        nf: nf ? "1" : undefined,
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

  /** 录像 ID 直达：跳详情页（不参与列表筛选，pickedRef 记选中后的 #id 防回弹） */
  function pickVideo(v: SuggestVideo) {
    pickedRef.current = `#${v.id}`;
    setItems(null);
    setQ(`#${v.id}`);
    router.push(`/video/${v.id}`);
  }

  function pickTime(value: string) {
    pickedRef.current = value;
    setItems(null);
    setQ(value);
    nav({ time: value });
  }

  /** 3BV 搜索（2026-10-20）：精确匹配该 3BV 的所有录像；回显值带「3BV 」前缀
   *  与时间成绩数字区分（「3BV 42」不会命中时间/ID 语义，回车提交也走 3BV 分支） */
  function pick3bv(value: number) {
    pickedRef.current = `3BV ${value}`;
    setItems(null);
    setQ(`3BV ${value}`);
    nav({ bv: String(value) });
  }

  function pickClear() {
    pickedRef.current = null;
    setItems(null);
    setQ("");
    nav({});
  }

  /** 回车无候选时提交：3BV 前缀→3BV 搜索；时间格式→时间搜索；纯整数→ID 录像直达；
   *  #前缀强制走 ID，否则玩家精确反查 */
  async function submit(text: string) {
    const raw = text.trim();
    // 「3BV 42」前缀（2026-10-20）：用户明确指定 3BV 搜索，跳过时间/ID 语义
    const bvMatch = raw.match(/^3BV\s+(\d{1,3})$/i);
    if (bvMatch) {
      const n = parseVideo3bv(bvMatch[1]);
      if (n != null) {
        pick3bv(n);
        return;
      }
    }
    const hash = raw.startsWith("#"); // # 前缀=用户明确指定录像/玩家 ID，跳过时间语义
    const key = raw.replace(/^#/, "");
    if (!key) return;
    if (!hash && VIDEO_TIME_INPUT_RE.test(key)) {
      const win = parseVideoTimeWindow(key);
      if (win) pickTime(scoreTime(win[0] + 5));
      return;
    }
    if (hash || /^\d+$/.test(key)) {
      // 纯整数：探测 ID 录像，命中直达；未命中回落玩家精确反查（同 ID 玩家；
      // user 模式作者锁定，无玩家回落 → 直接提示未找到）
      try {
        const res = await fetch(`/api/video/lookup?id=${key}`);
        if (res.ok) {
          const { video } = (await res.json()) as { video: SuggestVideo | null };
          if (video) {
            pickedRef.current = `#${video.id}`;
            setItems(null);
            setQ(`#${video.id}`);
            router.push(`/video/${video.id}`);
            return;
          }
        }
      } catch {
        /* 网络异常继续走玩家反查 */
      }
      if (isUser) {
        toast(`没有找到 ID 为 ${key} 的录像`);
        return;
      }
      const u = await findUser(key);
      if (u) pickUser(u);
      else toast(`没有找到 ID 为 ${key} 的录像或玩家`);
      return;
    }
    if (isUser) {
      toast("可输入时间成绩（如 37.29）、3BV 数值或录像 ID 进行查询");
      return;
    }
    const u = await findUser(key);
    if (u) pickUser(u);
    else toast("没有找到符合条件的玩家");
  }

  /** 玩家精确反查：中文名精确命中优先，否则取第一个候选 */
  async function findUser(key: string): Promise<SuggestUser | null> {
    try {
      const res = await fetch(`/api/ranking/search?q=${encodeURIComponent(key)}&limit=8`);
      if (res.ok) {
        const { users } = (await res.json()) as { users: SuggestUser[] };
        return users.find((u) => u.chineseName === key) ?? users[0] ?? null;
      }
    } catch {
      /* 网络异常走上方气泡 */
    }
    return null;
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
      else if (item.kind === "video") pickVideo(item.video);
      else if (item.kind === "time") pickTime(item.value);
      else if (item.kind === "3bv") pick3bv(item.value);
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
          placeholder={isUser ? "成绩/3BV/ID" : "玩家/成绩/3BV/ID"}
          title={
            isUser
              ? "输入时间成绩（秒，如 37.29）查找相同成绩的录像，输入 3BV 数值（如 42）查找相同 3BV 的录像，或输入录像 ID（如 345155）直达该录像"
              : "输入玩家姓名筛选其上传的录像，输入时间成绩（秒，如 37.29）查找相同成绩的所有录像，输入 3BV 数值（如 42）查找相同 3BV 的所有录像，或输入录像 ID（如 345155）直达该录像"
          }
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
            <li className="goto_empty">没有找到符合条件的玩家或录像</li>
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
              if (item.kind === "video") {
                return (
                  <li key={`v${item.video.id}`} className={cls || undefined}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pickVideo(item.video)}
                    >
                      <em>录像 #{item.video.id}</em>
                      <span>
                        {[
                          item.video.chineseName,
                          LEVEL_NAMES[item.video.level as Level] ?? item.video.level,
                          item.video.realTime != null ? `${scoreTime(item.video.realTime)}秒` : null,
                        ]
                          .filter(Boolean)
                          .join("・")}
                      </span>
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
              if (item.kind === "3bv") {
                return (
                  <li key="3bv" className={cls || undefined}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick3bv(item.value)}
                    >
                      <em>3BV {item.value}</em>
                      <span>找相同 3BV 的录像</span>
                    </button>
                  </li>
                );
              }
              // clear
              return (
                <li key="clear" className={cls || undefined}>
                  <button type="button" onMouseEnter={() => setActive(i)} onClick={pickClear}>
                    <em>清除搜索</em>
                    <span>{(isUser ? undefined : authorName) ?? (bv != null ? `3BV ${bv}` : time)}</span>
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
