// 排行导航条（2008 编排：左侧榜别切换 + 右侧查找定位，2026-09-23 张老师要求；
// 2026-09-24 三轮调整：双输入框合并为单个圆角搜索框——矢量放大镜 + placeholder「姓名或ID」；
// 2026-09-24 四轮：去掉「查找」按钮——汉字输入防抖模糊匹配出推荐下拉（键盘上下选、回车确认），
// 唯一候选自动定位；通过自定义事件 ranking:locate 委托同页的 RankingFeed 执行定位）
// 2026-10-13 张老师要求：底部「我在哪里」按钮取消——登录态下聚焦/清空搜索框且未输入时，
// 下拉直接推荐「自己」，回车即定位到自己在榜中的位置。
// 2026-10-14 BV 榜搜索（C 方案）：搜索框扩到 BV tab；带 bvBy 调搜索接口回带名次，
// 下拉次级文字只显示名次「第 3,168 位」（2026-10-14 张老师：不要带具体数值），
// 不在榜显示「未加入 BV 排行」（hint 置灰，选中弹气泡）；
// 唯一候选自动定位仅在候选确实在榜时触发（否则会立刻弹「未加入」气泡，体验突兀）。
// 2026-10-14 各榜统一（张老师要求）：雷界/NF 的搜索也带回名次（带 by，NF 加 nf=1），
// 下拉次级文字同为「第 N 位」/「未加入排行」，不再显示 ID 与英文名。
// 2026-10-14 地区内页搜索（张老师要求）：传 area 时搜索框出现在地区内页——推荐/「自己」
// 的名次均为地区内名次（搜索接口带 area），定位不走 ranking:locate 事件（地区内页是
// 服务端分页、无 RankingFeed 监听），改为轻量探测后整页导航 whereami（302 回 /area 带 page+hl）。

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast, toastLoading } from "./Toast";
import { NfToggle } from "./NfToggle";

export type RankingView = "all" | "bv" | "stnb" | "grow" | "area" | "world";

const TABS: { key: RankingView; label: string; href: string }[] = [
  { key: "all", label: "雷界", href: "/ranking" },
  { key: "bv", label: "BV", href: "/ranking?view=bv" },
  { key: "stnb", label: "STNB", href: "/ranking?view=stnb" },
  { key: "grow", label: "进步", href: "/grow" },
  { key: "area", label: "地区", href: "/area" },
  { key: "world", label: "世界", href: "/ranking?view=world" },
];

interface SuggestUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  /** BV/STNB 榜名次（仅缓存数组榜附加查询回带；缺失＝未加入该排行） */
  bvRank?: number;
  /** STNB 榜名次（同上） */
  stnbRank?: number;
  /** 成绩榜名次（带 by 附加查询回带；缺失＝未加入排行） */
  rank?: number;
}

export function RankingNav({
  current,
  by,
  me,
  area,
  nf = false,
}: {
  current: RankingView;
  by?: string;
  /** 登录用户信息：搜索框空输入时推荐「自己」（替代原「我在哪里」按钮） */
  me?: SuggestUser;
  /** 地区内页搜索：地区名（仅 /area?name=xx 传入；传入即启用地区模式搜索框） */
  area?: string;
  /** NF 正交筛选：成绩/BV/STNB 可用，其余榜禁用 */
  nf?: boolean;
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

  // BV / STNB 榜模式：搜索框带 by 查榜内名次——下拉直接给出名次或「未加入 XX 排行」
  const bvMode = current === "bv";
  const stnbMode = current === "stnb";
  const boardMode = bvMode || stnbMode; // 缓存数组榜（BV/STNB）公共分支
  const bvBy = boardMode ? (by ?? "total") : "";
  // 地区内页模式：搜索框带 by+area 查地区内名次（2026-10-14）
  const areaMode = current === "area" && !!area;
  const nfSupported = current === "all" || boardMode;

  /** 榜间切换只在支持 NF 的榜单间保留模式，其余榜强制回到混合/原口径 */
  function tabHref(key: RankingView, fallback: string): string {
    if (!nf || !(key === "all" || key === "bv" || key === "stnb")) return fallback;
    return `${fallback}${fallback.includes("?") ? "&" : "?"}nf=1`;
  }

  /** 定位/查询统一带的榜别参数（BV/STNB；成绩榜 NF 独立使用 nf=1） */
  function viewParam(): string | undefined {
    return bvMode ? "bv" : stnbMode ? "stnb" : undefined;
  }

  function toggleNf(next: boolean) {
    if (!nfSupported) return;
    const qs = new URLSearchParams();
    if (boardMode) qs.set("view", current);
    if (by && by !== (boardMode ? "total" : "sum_time")) qs.set("by", by);
    if (next) qs.set("nf", "1");
    const query = qs.toString();
    router.push(`/ranking${query ? `?${query}` : ""}`);
  }

  /** 该候选是否在榜（缓存数组榜看 bvRank/stnbRank、成绩榜看 rank；都由搜索接口回带） */
  function inBoard(u: SuggestUser): boolean {
    return bvMode ? u.bvRank !== undefined : stnbMode ? u.stnbRank !== undefined : u.rank !== undefined;
  }

  /** 下拉次级文字（各榜统一只显示名次，未在榜显示提示并置灰） */
  function suggestMeta(u: SuggestUser): { text: string; inBoard: boolean } {
    if (inBoard(u)) {
      const rank = bvMode ? u.bvRank! : stnbMode ? u.stnbRank! : u.rank!;
      return { text: `第 ${rank.toLocaleString("zh-CN")} 位`, inBoard: true };
    }
    return {
      text: bvMode
        ? "未加入 BV 排行"
        : stnbMode
          ? "未加入 STNB 排行"
          : areaMode
            ? "未加入地区排行"
            : "未加入排行",
      inBoard: false,
    };
  }

  // 登录态：聚焦/清空输入时下拉推荐自己；回车选中即定位（走既有 pick 流程）
  // 名次实时刷新（2026-10-27 修复）：me.bvRank/rank 是页面 SSR 快照——BV/STNB 榜数据
  // 1 小时缓存再验证后榜单换代（典型：自己新录像过审、名次跳变），页面放旧了下拉名次
  // 就与列表对不上（实证：快照显示 592，翻到第 30 页找不到人，实榜已到 574）。
  // 聚焦/清空时按数字 ID 现查搜索接口刷新（接口零重活：缓存数组内存查/索引区间统计）。
  // meFresh 带榜别上下文键，软导航切榜/切 NF 后只认当前上下文的新查结果，否则回退 SSR 快照。
  const meCtx = `${current}-${by ?? ""}-${nf ? "1" : "0"}-${areaMode ? area : ""}`;
  const [meFresh, setMeFresh] = useState<{ key: string; user: SuggestUser } | null>(null);
  const meSuggest = me ? [meFresh && meFresh.key === meCtx ? meFresh.user : me] : null;
  async function refreshMeSuggest() {
    if (!me) return;
    const qs = new URLSearchParams({ q: String(me.id) });
    if (boardMode) {
      qs.set("bvBy", bvBy);
      if (stnbMode) qs.set("stnb", "1");
      if (nf) qs.set("nf", "1");
    } else if (by) {
      qs.set("by", by);
      if (nf && !areaMode) qs.set("nf", "1");
      if (areaMode) qs.set("area", area!);
    }
    try {
      const res = await fetch(`/api/ranking/search?${qs}`);
      if (!res.ok) return;
      const { users: list } = (await res.json()) as { users: SuggestUser[] };
      const hit = list.find((u) => u.id === me.id);
      if (hit) setMeFresh({ key: meCtx, user: hit });
    } catch {
      /* 网络异常静默：保留 SSR 快照 */
    }
  }
  function suggestMe() {
    if (!meSuggest) return;
    setUsers(meSuggest);
    setActive(0);
    void refreshMeSuggest();
  }

  // 数字输入也出推荐（按 ID 精确匹配实时推荐玩家）；下拉项的次级文字数字模式显示 ID
  const kw = q.trim();
  const numeric = /^\d+$/.test(kw);
  // 无匹配空态提示（2026-09-24 张老师要求）：ID 精确不中 / 姓名无匹配
  const emptyMsg = numeric ? `没有找到ID为${kw}的玩家` : "没有找到符合条件的玩家";

  // 地区内页定位（2026-10-14）：本页无 RankingFeed 监听 ranking:locate，
  // 直接轻量探测（未在榜弹气泡）后整页导航 whereami（302 回 /area 带 page+hl）
  async function locateArea(id: number) {
    const qs = new URLSearchParams({ id: String(id), area: area!, format: "json" });
    if (by) qs.set("by", by);
    try {
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const { page } = (await res.json()) as { page: number };
        if (page <= 0) {
          toast("该玩家未加入该地区排行（暂无成绩）");
          return;
        }
      }
    } catch {
      /* 探测失败走导航兜底 */
    }
    const nav = new URLSearchParams({ id: String(id), area: area! });
    if (by) nav.set("by", by);
    router.push(`/ranking/whereami?${nav}`);
  }

  // 事件委托：RankingFeed 在同页监听并执行定位（页内滚动/拉取/跳 whereami）
  function locate(id: number) {
    // 搜索等待气泡（2026-10-27 张老师要求）：定位链路有延迟（whereami 探测/拉缺页/跳转），
    // 立即弹「搜索中」；不跳转的分支由 Feed 调 toastLoadingDone 关闭，跳转的由 URL 变化自动关闭
    toastLoading();
    if (areaMode) {
      void locateArea(id);
      return;
    }
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
        // 榜单名次：BV/STNB 带 bvBy（1 小时缓存数组内存查，零 DB）；成绩榜带 by（+nf）走索引区间统计；
        // 地区内页另带 area（名次限定该地区人口）
        if (boardMode) {
          qs.set("bvBy", bvBy);
          if (stnbMode) qs.set("stnb", "1");
          if (nf) qs.set("nf", "1");
        } else if (by) {
          qs.set("by", by);
          if (nf && !areaMode) qs.set("nf", "1");
          if (areaMode) qs.set("area", area!);
        }
        const res = await fetch(`/api/ranking/search?${qs}`);
        if (!res.ok) return;
        const { users: list } = (await res.json()) as { users: SuggestUser[] };
        if (seq !== reqSeq.current) return; // 已有更新的输入
        setUsers(list);
        setActive(0);
        // 唯一候选 → 自动开始查询（张老师要求：确定只有一个选择即触发，无需输完姓名）
        // 仅限姓名输入；数字 ID 输入始终展示候选列表（用户可能还要继续输位数）
        // 另要求候选确实在榜（接口带回名次信息时才有此判据）——否则自动定位会立刻弹「未加入」气泡
        // 注：此处内联判据（不调 inBoard()）——外部函数进依赖数组会让 effect 每渲染重跑
        const first = list[0];
        const firstInBoard = first
          ? bvMode
            ? first.bvRank !== undefined
            : stnbMode
              ? first.stnbRank !== undefined
              : first.rank !== undefined
          : false;
        if (list.length === 1 && !numeric && (!(boardMode || by) || firstInBoard)) {
          setUsers(null);
          locate(first.id);
        }
      } catch {
        /* 网络异常静默：回车提交仍可用 */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, bvBy, boardMode, bvMode, stnbMode, by, current, numeric, areaMode, area, nf]);

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
    // 搜索等待气泡（2026-10-27）：探测 + 整页导航都有延迟，先弹「搜索中」；
    // 无成绩分支的 toast 会顶替它，跳转分支由 URL 变化自动渐隐
    toastLoading();
    const qs = new URLSearchParams({ name, format: "json" });
    if (by) qs.set("by", by);
    if (view) qs.set("view", view);
    if (nf && nfSupported) qs.set("nf", "1");
    if (areaMode) qs.set("area", area!);
    try {
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const { page } = (await res.json()) as { page: number };
        if (page <= 0) {
          toast(
            bvMode
              ? "该玩家暂无已通过审核的录像，未加入 BV 排行"
              : stnbMode
                ? "该玩家暂无有效 STNB 成绩，未加入 STNB 排行"
                : areaMode
                  ? "该玩家未加入该地区排行（暂无成绩）"
                  : "该玩家未加入排行榜（暂无成绩）"
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
    if (nf && nfSupported) nav.set("nf", "1");
    if (areaMode) nav.set("area", area!);
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
      <div className="ranking_left">
        <div className="ranking_tabs">
          {TABS.map((t) =>
            t.key === current ? (
              <span key={t.key} className="current">
                {t.label}
              </span>
            ) : (
              <Link key={t.key} href={tabHref(t.key, t.href)}>
                {t.label}
              </Link>
            )
          )}
        </div>
        <NfToggle
          active={nf && nfSupported}
          disabled={!nfSupported}
          tip={nfSupported ? (nf ? "只统计 NF 录像" : "开启后只统计 NF 录像") : "该榜不支持 NF 筛选"}
          onToggle={toggleNf}
        />
      </div>
      {(current === "all" || boardMode || areaMode) && (
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
                  const meta = suggestMeta(u);
                  // 不在榜的候选置灰（hint），active 态优先级更高（CSS 中 hint 规则在前）
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
                        {/* 各榜统一：次级文字显示名次（不在榜则显示「未加入…排行」并置灰） */}
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
