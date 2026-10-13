// 排行导航条（2008 编排：左侧榜别切换 + 右侧查找定位，2026-09-23 张老师要求；
// 2026-09-24 三轮调整：双输入框合并为单个圆角搜索框——矢量放大镜 + placeholder「姓名或ID」；
// 2026-09-24 四轮：去掉「查找」按钮——汉字输入防抖模糊匹配出推荐下拉（键盘上下选、回车确认），
// 唯一候选自动定位；通过自定义事件 ranking:locate 委托同页的 RankingFeed 执行定位）
// 2026-10-13 张老师要求：底部「我在哪里」按钮取消——登录态下聚焦/清空搜索框且未输入时，
// 下拉直接推荐「自己」，回车即定位到自己在榜中的位置。
// 2026-10-14 BV 榜搜索（C 方案）：搜索框扩到 BV tab；带 bvBy 调搜索接口回带名次，
// 下拉次级文字只显示名次「第 3,168 位」（2026-10-14 张老师：不要带具体数值），
// 不在榜显示「未加入 BV 排行」（hint 置灰，选中弹气泡）；
// 唯一候选自动定位在 BV 模式下仅当候选确实在榜（否则会立刻弹「未加入」气泡，体验突兀）。

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";

export type RankingView = "all" | "nf" | "bv" | "grow" | "area" | "world";

const TABS: { key: RankingView; label: string; href: string }[] = [
  { key: "all", label: "雷界", href: "/ranking" },
  { key: "nf", label: "NF", href: "/ranking?view=nf" },
  { key: "bv", label: "BV", href: "/ranking?view=bv" },
  { key: "grow", label: "进步", href: "/grow" },
  { key: "area", label: "地区", href: "/area" },
  { key: "world", label: "世界", href: "/ranking?view=world" },
];

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  /** BV 榜名次（仅 BV 附加查询回带；缺失＝未加入 BV 排行） */
  bvRank?: number;
}

export function RankingNav({
  current,
  by,
  me,
}: {
  current: RankingView;
  by?: string;
  /** 登录用户信息：搜索框空输入时推荐「自己」（替代原「我在哪里」按钮） */
  me?: SuggestUser;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<SuggestUser[] | null>(null);
  const [active, setActive] = useState(0); // 键盘上下键游标
  const boxRef = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0); // 竞态：仅最后一次请求生效
  // 选中推荐项时会把输入框写成该项姓名，q 变化会立刻触发新一轮模糊推荐 → 下拉在跳转/滚动
  // 后又冒出来盖住表格（2026-10-14 张老师要求：选中即收起）。记下刚选中的关键字，跳过这一轮。
  const pickedRef = useRef<string | null>(null);

  // BV 榜模式：搜索框带 by 查榜内名次——下拉直接给出「第 N 位 · 收集数/分母」
  const bvMode = current === "bv";
  const bvBy = bvMode ? (by ?? "total") : "";

  /** 定位/查询统一带的榜别参数（成绩榜 view=nf、BV 榜 view=bv） */
  function viewParam(): string | undefined {
    return current === "nf" ? "nf" : bvMode ? "bv" : undefined;
  }

  /** BV 下拉次级文字：在榜→只显示名次；不在榜→置灰「未加入 BV 排行」 */
  function suggestMeta(u: SuggestUser, numeric: boolean): { text: string; inBoard: boolean } {
    if (!bvMode) return { text: numeric ? `ID ${u.id}` : u.englishName, inBoard: true };
    if (!u.bvRank) return { text: "未加入 BV 排行", inBoard: false };
    return { text: `第 ${u.bvRank.toLocaleString("zh-CN")} 位`, inBoard: true };
  }

  // 登录态：聚焦/清空输入时下拉推荐自己；回车选中即定位（走既有 pick 流程）
  const meSuggest = me ? [me] : null;
  function suggestMe() {
    if (!meSuggest) return;
    setUsers(meSuggest);
    setActive(0);
  }

  // 数字输入也出推荐（按 ID 精确匹配实时推荐玩家）；下拉项的次级文字数字模式显示 ID
  const kw = q.trim();
  const numeric = /^\d+$/.test(kw);
  // 无匹配空态提示（2026-09-24 张老师要求）：ID 精确不中 / 姓名无匹配
  const emptyMsg = numeric ? `没有找到ID为${kw}的玩家` : "没有找到符合条件的玩家";

  // 事件委托：RankingFeed 在同页监听并执行定位（页内滚动/拉取/跳 whereami）
  function locate(id: number) {
    window.dispatchEvent(new CustomEvent("ranking:locate", { detail: { id } }));
  }

  // 防抖 250ms 模糊推荐（setState 只发生在异步回调里，规避 set-state-in-effect）
  useEffect(() => {
    const kw = q.trim();
    if (!kw) {
      reqSeq.current++; // 使在途请求失效
      pickedRef.current = null;
      return;
    }
    // 刚刚选中过推荐项（输入框被写成该项姓名）→ 不为同一关键字重新拉推荐，保持收起
    if (pickedRef.current === kw) {
      reqSeq.current++;
      return;
    }
    pickedRef.current = null;
    const seq = ++reqSeq.current;
    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ q: kw });
        // BV 榜：附带名次（接口从 1 小时缓存的榜数组取，不额外打库）
        if (bvBy) qs.set("bvBy", bvBy);
        const res = await fetch(`/api/ranking/search?${qs}`);
        if (!res.ok) return;
        const { users: list } = (await res.json()) as { users: SuggestUser[] };
        if (seq !== reqSeq.current) return; // 已有更新的输入
        setUsers(list);
        setActive(0);
        // 唯一候选 → 自动开始查询（张老师要求：确定只有一个选择即触发，无需输完姓名）
        // 仅限姓名输入；数字 ID 输入始终展示候选列表（用户可能还要继续输位数）
        // BV 榜额外要求候选确实在榜——否则自动定位会立刻弹「未加入」气泡，体验突兀
        const autoOk = bvMode ? list[0]?.bvRank !== undefined : true;
        if (list.length === 1 && !/^\d+$/.test(kw) && autoOk) {
          setUsers(null);
          locate(list[0].id);
        }
      } catch {
        /* 网络异常静默：回车提交仍可用 */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, bvBy, bvMode]);

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
    const view = viewParam();
    // 先轻量探测（json）：无成绩/不存在 → 全局居中气泡提示，不跳转
    const qs = new URLSearchParams({ name, format: "json" });
    if (by) qs.set("by", by);
    if (view) qs.set("view", view);
    try {
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const { page } = (await res.json()) as { page: number };
        if (page <= 0) {
          toast(
            bvMode ? "该玩家暂无已通过审核的录像，未加入 BV 排行" : "该玩家未加入排行榜（暂无成绩）"
          );
          return;
        }
      }
    } catch {
      /* 探测失败走导航兜底 */
    }
    const nav = new URLSearchParams({ name });
    if (by) nav.set("by", by);
    if (view) nav.set("view", view);
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
        pickedRef.current = pick.chineseName.trim(); // 抑制随后那轮同名推荐
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
      {(current === "all" || current === "nf" || bvMode) && (
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
              onChange={(e) => {
                setQ(e.target.value);
                // 清空输入 → 回到「推荐自己」态（登录时）
                if (!e.target.value.trim()) suggestMe();
              }}
              onFocus={() => {
                if (!q.trim()) suggestMe();
              }}
              onKeyDown={onKeyDown}
              autoComplete="off"
            />
          </span>
          {/* 有输入 → 模糊推荐/空态；无输入（登录态）→ 推荐自己（onFocus/onChange 已把 users 置为 [me]） */}
          {users !== null && (kw !== "" || meSuggest !== null) && (
            <ul className="goto_suggest">
              {users.length === 0 ? (
                <li className="goto_empty">{emptyMsg}</li>
              ) : (
                users.map((u, i) => {
                  const meta = suggestMeta(u, numeric);
                  // 不在 BV 榜的候选置灰（hint），active 态优先级更高（CSS 中 hint 规则在前）
                  const cls = [i === active ? "active" : "", meta.inBoard ? "" : "hint"]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <li key={u.id} className={cls || undefined}>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => {
                          pickedRef.current = u.chineseName.trim(); // 抑制随后那轮同名推荐
                          setUsers(null);
                          setQ(u.chineseName);
                          locate(u.id);
                        }}
                      >
                        <em>{u.chineseName}</em>
                        {/* BV 榜：名次 + 收集进度；成绩榜数字模式显示 ID、其余显示英文名 */}
                        <span>{meta.text || null}</span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
