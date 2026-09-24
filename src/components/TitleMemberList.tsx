// 军衔玩家列表（2026-09-24 张老师要求改版）：
// - 顶部：完整大徽章（与军衔页卡片一致的 RankBadge 大图，由服务端页渲染）
// - 表格：照搬排行榜 RankingTable 编排（排名/姓名/军衔/8 列成绩），
//   仅截选本军衔区间的玩家，名次=全局总时间名次
// - 每页 20 条，「加载更多」走 /api/titles/more 增量渲染
// - 登录后显示「我在哪里?」按钮：服务端预算 offset，客户端补齐中间页后滚动定位
// 预备役：无成绩列，序号/姓名/注册时间

"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import type { TitleMemberRow } from "@/lib/queries";
import { scoreTime, formatDate, totalLabel } from "@/lib/format";
import { TitleBadge } from "./Cells";
import { noFocusJump } from "./useKeepScroll";

const COLS: { by: string; label: string; cls: string }[] = [
  { by: "beg_time", label: "初级", cls: "c_beg" },
  { by: "beg_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "int_time", label: "中级", cls: "c_int" },
  { by: "int_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "exp_time", label: "高级", cls: "c_exp" },
  { by: "exp_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "sum_time", label: "总计", cls: "c_sum" },
  { by: "sum_3bvs", label: "3BV/s", cls: "c_3bvs" },
];

function ScoreCell({ row, col }: { row: TitleMemberRow; col: (typeof COLS)[number] }) {
  const v = row.scores[col.by];
  const isTime = col.by.endsWith("_time");
  if (!v) return <td className={col.cls}>-</td>;
  const neg = !isTime && v < 0;
  const text = isTime ? scoreTime(v) : ((neg ? -v : v) / 1000).toFixed(2);
  const videoId = row.videos[col.by];
  const inner = neg ? <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">{text}</del> : text;
  return (
    <td className={col.cls}>
      {videoId ? (
        <Link href={`/video/${videoId}`} target="_blank" title="点击查看录像">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </td>
  );
}

export function TitleMemberList({
  title,
  memberTitle,
  initial,
  initialHasMore,
  total,
  myId,
  myOffset,
}: {
  title: string;
  /** 本军衔显示名（客户端无 distribution，由服务端传入用于 TitleBadge） */
  memberTitle: string;
  initial: TitleMemberRow[];
  initialHasMore: boolean;
  /** 本军衔玩家总数（「加载更多」括号内显示剩余条数用） */
  total: number;
  /** 登录用户 id（未登录=null） */
  myId: number | null;
  /** 我在本军衔列表的行偏移（不在本军衔=-1/null 不显示按钮） */
  myOffset: number | null;
}) {
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [located, setLocated] = useState(false);

  async function fetchPage(cur: number): Promise<{ rows: TitleMemberRow[]; hasMore: boolean }> {
    const res = await fetch(
      `/api/titles/more?title=${encodeURIComponent(title)}&cursor=${cur}&size=20`
    );
    return await res.json();
  }

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    try {
      const data = await fetchPage(cursor);
      setRows((prev) => [...prev, ...data.rows]);
      setCursor((prev) => prev + data.rows.length);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }

  // 「我在哪里」：一次取到包含本人的最后一页（中间页合并丢弃边界处理：直接逐页补齐更稳）
  async function locateMe() {
    if (loading || locating || myId == null || myOffset == null || myOffset < 0) return;
    setLocating(true);
    try {
      let cur = cursor;
      let acc: TitleMemberRow[] = [];
      // 逐页取，直到覆盖本人位置或没有更多
      while (rows.length + acc.length < myOffset + 1) {
        const data = await fetchPage(cur);
        if (!data.rows.length) break;
        acc = [...acc, ...data.rows];
        cur += data.rows.length;
        if (!data.hasMore) {
          setHasMore(false);
          break;
        }
      }
      if (acc.length) {
        setRows((prev) => [...prev, ...acc]);
        setCursor(cur);
      }
      setLocated(true);
      // 等 React 提交后滚动到本人行
      setTimeout(() => {
        document.getElementById(`id_${myId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 120);
    } finally {
      setLocating(false);
    }
  }

  const isReserve = title === "预备役";

  return (
    <>
      <table cellPadding={0} cellSpacing={0} className="ranking_table title_members">
        <thead>
          <tr>
            <th>排名</th>
            <th>姓名</th>
            <th>军衔</th>
            {isReserve ? <th>注册时间</th> : COLS.map((c) => <th key={c.by}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => (
            <tr
              key={u.id}
              id={`id_${u.id}`}
              className={myId != null && u.id === myId ? "highlight" : undefined}
            >
              <td className="rank">
                {isReserve ? (
                  <>
                    第&nbsp;<em>{i + 1}</em>&nbsp;名
                  </>
                ) : (
                  <>
                    第&nbsp;<em>{u.rank}</em>&nbsp;位
                  </>
                )}
              </td>
              <td className="name">
                <Link href={`/user/${u.id}`} target="_blank" title="点击查看个人信息">
                  {u.chineseName}
                </Link>
                <span className={`gender ${u.sex ? "male" : "female"} small`}></span>
              </td>
              <td className="miltitle">
                <TitleBadge title={memberTitle} link />
              </td>
              {isReserve ? (
                <td className="tac">{u.createTime ? formatDate(u.createTime, "Y-n-j") : "-"}</td>
              ) : (
                COLS.map((c) => <ScoreCell key={c.by} row={u} col={c} />)
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={isReserve ? 4 : 11} style={{ textAlign: "center" }}>
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="more_loader title_members_actions">
        {hasMore && (
          <button
            type="button"
            className="button small"
            disabled={loading}
            onMouseDown={noFocusJump}
            onClick={loadMore}
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        )}
        <span className="total_count">{totalLabel(total, "人")}</span>
        {myId != null && myOffset != null && myOffset >= 0 && !located && (
          <button type="button" className="button small" disabled={locating} onClick={locateMe}>
            {locating ? "定位中…" : "我在哪里?"}
          </button>
        )}
      </div>
    </>
  );
}
