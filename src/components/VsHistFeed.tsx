"use client";

// 历史对决板块（2026-11-11 15:48 张老师改版）：对决页分割线下常显（仅「就位」态），
// 行渲染对齐玩家卡片（AvatarCell 姓名+性别 + TitleBadge 军衔），胜负平用后台
// admin_tag 同款三色标签；底部全站通用「加载更多 + 页码滑条」翻页器（PageSlider）：
// ··· 加载更多 = 追加下一批（每页 10 条）；滑条跳页 = 整窗替换。
// 开跑后整块由父级（VsScoreBoard）按舞台状态摘除，本组件只管数据与渲染。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { formatDate } from "@/lib/format";
import { PageSlider } from "./PageSlider";
import type { VsHistRow } from "@/lib/vs";

const RESULT_TAG: Record<number, { cls: string; label: string }> = {
  1: { cls: "ok", label: "胜" },
  2: { cls: "bad", label: "负" },
  0: { cls: "plain", label: "平" },
};

/** 比分着色（发起者视角，同后台口径）：胜方金 / 负方亮灰 / 平局与未算亮灰 — */
function histScore(s: number | null, win: boolean) {
  return s === null ? (
    <span className="gray">—</span>
  ) : (
    <b className={"vs_hist_s" + (win ? " vs_hist_s_win" : " vs_hist_s_lose")}>{s.toFixed(2)}</b>
  );
}

export function VsHistFeed({
  uid1,
  uid2,
  initial,
  total,
  pageSize,
}: {
  uid1: number;
  uid2: number;
  /** RSC 首屏传入的第 1 页行（对应初始 uid 组合；换人后由下方 effect 重拉覆盖） */
  initial: VsHistRow[];
  total: number;
  pageSize: number;
}) {
  const [rows, setRows] = useState<VsHistRow[]>(initial);
  // loaded=加载更多游标（已加载到的页）；viewPage=滑条所在页（跳页/追加后同步）
  const [loaded, setLoaded] = useState(1);
  const [viewPage, setViewPage] = useState(1);
  const [loading, setLoading] = useState(false);
  // 总数可变：换人后 uids 变化，服务端 total 随之不同（首屏取 prop，之后跟 API 走）
  const [totalCount, setTotalCount] = useState(total);
  // 序号门槛：滑条快速连拖时旧响应一律作废（全站 Feed 同款语义）
  const seq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasMore = rows.length < totalCount;

  async function request(p: number, append: boolean) {
    const my = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/vs/history?l=${uid1}&r=${uid2}&page=${p}`);
      if (!res.ok) return;
      const data = (await res.json()) as { rows?: VsHistRow[]; total?: number };
      if (my !== seq.current) return;
      const got = data.rows ?? [];
      setRows((list) => (append ? [...list, ...got] : got));
      if (typeof data.total === "number") setTotalCount(data.total);
      setLoaded(p);
      setViewPage(p);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }
  const onMore = () => {
    if (loading || !hasMore) return;
    request(loaded + 1, true);
  };
  const onGoto = (p: number) => {
    if (loading || p === viewPage) return;
    request(p, false);
  };

  // 换人跟随（2026-11-11 17:23 张老师：竞技场/就地换人后历史对决要跟着换）：
  // uids 变化即整窗重拉第 1 页（initial 是服务端按**初始** uid 组合预取的，
  // 不再对应新组合）。首挂载跳过——数据就是 initial，拉一遍纯属浪费。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (!uid1 && !uid2) return; // 双空位由父级摘除板块，兜底不请求
    void request(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- uids 变化即重拉；request 恒取最新 state
  }, [uid1, uid2]);

  return (
    <div className="vs_histbox">
      {rows.length === 0 ? (
        <p className="vs_hist_empty">暂无对决记录（VS 页访问后开始落库）</p>
      ) : (
        <table className="vs_hist_tbl">
          <tbody>
            {rows.map((d) => {
              const res = d.result;
              const tag = res === null ? null : RESULT_TAG[res];
              return (
                <tr key={d.id}>
                  <td className="vs_hist_time" title={formatDate(d.time, "Y-m-d H:i:s")}>
                    {formatDate(d.time, "m-d H:i")}
                  </td>
                  <td className="vs_hist_name">
                    {/* 姓名后跟性别 + 军衔：与玩家卡片 .ucd_name 同一套 AvatarCell + TitleBadge */}
                    <AvatarCell id={d.u1} name={d.n1} englishName={d.en1} sex={d.sex1} gender="small" link />
                    <TitleBadge title={d.t1} link />
                  </td>
                  <td className="vs_hist_c">{histScore(d.s1, res === 1)}</td>
                  <td className="vs_hist_c vs_hist_res">
                    {tag ? <span className={`admin_tag ${tag.cls}`}>{tag.label}</span> : <span className="gray">—</span>}
                  </td>
                  <td className="vs_hist_c">{histScore(d.s2, res === 2)}</td>
                  <td className="vs_hist_name">
                    <AvatarCell id={d.u2} name={d.n2} englishName={d.en2} sex={d.sex2} gender="small" link />
                    <TitleBadge title={d.t2} link />
                  </td>
                  <td className="vs_hist_look">
                    {/* 回看（行 hover 浮现，触屏常显）：跳该行两玩家的对决页 */}
                    <Link className="vs_look" href={`/vs/${d.u1}/${d.u2}`} prefetch={false}>
                      回看
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {/* 全站通用翻页器：···加载更多 + ◀ 滑轨 ▶ 第 n / N 页（单页也渲染整行灰态） */}
      <div className="list_footer">
        <PageSlider page={viewPage} pages={maxPage} loading={loading} onGoto={onGoto} hasMore={hasMore} onMore={onMore} />
      </div>
    </div>
  );
}
