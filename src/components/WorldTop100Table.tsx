// 世界 TOP100 表格 + 底部标准翻页滑条（2026-10-15 张老师要求：替代原「加载更多」
// more_loader 版式，改用与排行/录像等列表同款 PageSlider；最右侧加「查看完整排行」
// 外链按钮，新窗口打开 minesweepergame.com 完整榜。数据由服务端一次性抓全（1 天缓存），
// 全程零请求）
// 2026-10-15 二轮（张老师要求）：滑条左侧保留标准「···加载更多」按钮——窗口语义与
// RankingFeed 对齐（本地数据版）：··· 按递增批量追加（15→+30→+60→封顶 100），
// 滑条窗口内滚动定位、窗口外严格一页整表替换。
// 2026-09-24 二轮：每级纪录后灰色括号日期；总成绩两位小数。
// 2026-09-24 六轮：Country/Name 合并一列（表头 Country / Name，国旗+空格+名字，左对齐）。
// 2026-09-24 五轮：纪录数字加粗 + 分级颜色与主排行榜一致（初 #999994/中 #bbbbaf/高 #ddddcf/总 #e6e6da）；
// 有录像文件的纪录可点击，经 /api/world/video 代理原站 avf 用站内 flop 播放器播放。

"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { WorldRow } from "@/lib/worldtop";
import { WORLD_RANKING_PAGE } from "@/lib/worldtop";
import { PageSlider, nextBatchSize } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { playFlop } from "./FlopPlayer";

const PAGE = 15;

/** 单级成绩：加粗数字（分级配色）+ 灰色括号日期；有录像则点击播放（flop 播放器 + 原站文件代理） */
function Score({
  v,
  date,
  vid,
  pid,
  cls,
}: {
  v: string;
  date: string;
  vid: string;
  pid: string;
  cls: string;
}) {
  const uri = vid ? `/api/world/video?pid=${pid}&f=${encodeURIComponent(vid)}` : "";
  const num = <b className={cls}>{v}</b>;
  return (
    <>
      {vid ? (
        <a
          href={uri}
          title="点击播放录像"
          onClick={(e) => {
            e.preventDefault();
            playFlop(uri);
          }}
        >
          {num}
        </a>
      ) : (
        num
      )}
      {date && <span className="date">（{date}）</span>}
    </>
  );
}

export function WorldTop100Table({ rows }: { rows: WorldRow[] }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const maxPage = Math.max(1, Math.ceil(rows.length / PAGE));
  // 窗口语义与 RankingFeed 对齐（本地数据版，全程零请求）：
  // ··· 加载更多 = 窗口末尾按递增批量追加（15 → +30 → +60 → 封顶 100，张老师 2026-10-15
  //     要求滑条左侧保留 ··· 按钮）；滑条换页 = 窗口内滚动定位（不换表），窗口外严格
  //     一页整表替换（批量序列重置，视口零跳动）
  const [winStart, setWinStart] = useState(1);
  const [winEnd, setWinEnd] = useState(1);
  const [curPage, setCurPage] = useState(1);
  const [batchStep, setBatchStep] = useState(0);

  const startRow = (winStart - 1) * PAGE;
  const endRow = Math.min(rows.length, winEnd * PAGE);

  function scrollToRowIdx(idx: number) {
    const tr = tableRef.current?.querySelectorAll("tbody tr")[idx];
    tr?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function loadMore() {
    const lastLoaded = Math.min(rows.length, winEnd * PAGE);
    const appended = Math.min(nextBatchSize(batchStep, PAGE), rows.length - lastLoaded);
    if (appended <= 0) return;
    setWinEnd(Math.min(maxPage, Math.ceil((lastLoaded + appended) / PAGE)));
    setBatchStep((s) => s + 1);
  }

  function gotoPage(p: number) {
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    // 窗口内：滚动定位（不换表）
    if (p >= winStart && p <= winEnd) {
      setCurPage(p);
      scrollToRowIdx(p - winStart);
      return;
    }
    // 窗口外：严格一页整表替换（flushSync 保视口锚点还原有效），批量序列重置
    const anchor = captureViewportAnchor(tableRef.current);
    flushSync(() => {
      setWinStart(p);
      setWinEnd(p);
      setCurPage(p);
    });
    restoreViewportAnchor(tableRef.current, anchor);
    setBatchStep(0);
  }

  return (
    // rank_scroll：表格与页脚（翻页滑条/查看完整排行）同宽，窄屏盒内横滑时一起滚
    <div className="rank_scroll">
        <table ref={tableRef} cellPadding={0} cellSpacing={0}>
          <thead>
            <tr>
              <th>Rank</th>
              <th className="name">Country / Name</th>
              <th>Beg</th>
              <th>Int</th>
              <th>Exp</th>
              <th>Sum</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(startRow, endRow).map((r) => (
              <tr key={r.rank} className={r.flag === "china" ? "ours" : ""}>
                <td className="rank">
                  No.&nbsp;<em>{r.rank}</em>
                </td>
                <td className="name">
                  <img
                    className="flag"
                    src={`/images/flags/${r.flag}.gif`}
                    alt={r.flag}
                    title={r.flag}
                    width={20}
                    height={13}
                  />{" "}
                  {r.name}
                </td>
                <td className="t">
                  <Score v={r.beg} date={r.begDate} vid={r.begVid} pid={r.pid} cls="s_beg" />
                </td>
                <td className="t">
                  <Score v={r.int} date={r.intDate} vid={r.intVid} pid={r.pid} cls="s_int" />
                </td>
                <td className="t">
                  <Score v={r.exp} date={r.expDate} vid={r.expVid} pid={r.pid} cls="s_exp" />
                </td>
                <td className="sum">{Number(r.sum).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="list_footer world_pager">
          <PageSlider
            page={curPage}
            pages={maxPage}
            loading={false}
            onGoto={gotoPage}
            hasMore={winEnd < maxPage}
            onMore={loadMore}
          />
          {/* 2026-10-15 张老师要求：最右侧「查看完整排行」外链（minesweepergame.com，新窗口） */}
          <a
            className="button small pager_full_btn"
            href={WORLD_RANKING_PAGE}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看完整排行
          </a>
        </div>
    </div>
  );
}
