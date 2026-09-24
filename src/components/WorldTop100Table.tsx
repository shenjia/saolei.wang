// 世界 TOP100 表格 + 「加载更多」（2026-09-24 张老师要求：默认只显示前 15 条，下面可加载更多）
// 数据由服务端一次性抓全（minesweepergame.com，1 天缓存），加载更多只是本地增量展开，
// 不再发请求——与首页「录像」feed 同款的 more_loader 版式与交互语言。
// 2026-09-24 二轮：每级纪录后灰色括号日期；总成绩两位小数。
// 2026-09-24 六轮：Country/Name 合并一列（表头 Country / Name，国旗+空格+名字，左对齐）。
// 2026-09-24 五轮：纪录数字加粗 + 分级颜色与主排行榜一致（初 #999994/中 #bbbbaf/高 #ddddcf/总 #e6e6da）；
// 有录像文件的纪录可点击，经 /api/world/video 代理原站 avf 用站内 flop 播放器播放。

"use client";

import { useState } from "react";
import type { WorldRow } from "@/lib/worldtop";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";
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
  const [shown, setShown] = useState(PAGE);
  const hasMore = shown < rows.length;

  return (
    <>
      <table cellPadding={0} cellSpacing={0}>
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
          {rows.slice(0, shown).map((r) => (
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
      <div className="more_loader">
        {hasMore ? (
          <button
            type="button"
            className="button small"
            onMouseDown={noFocusJump}
            onClick={() => setShown((n) => Math.min(n + PAGE, rows.length))}
          >
            加载更多
          </button>
        ) : (
          rows.length > 0 && <span className="all_loaded">已加载全部</span>
        )}
        <TotalCount total={rows.length} unit="位" />
      </div>
    </>
  );
}
