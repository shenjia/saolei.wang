// 世界 TOP100 表格 + 「加载更多」（2026-09-24 张老师要求：默认只显示前 15 条，下面可加载更多）
// 数据由服务端一次性抓全（minesweepergame.com，1 天缓存），加载更多只是本地增量展开，
// 不再发请求——与首页「录像」feed 同款的 more_loader 版式与交互语言。

"use client";

import { useState } from "react";
import type { WorldRow } from "@/lib/worldtop";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

const PAGE = 15;

export function WorldTop100Table({ rows }: { rows: WorldRow[] }) {
  const [shown, setShown] = useState(PAGE);
  const hasMore = shown < rows.length;

  return (
    <>
      <table cellPadding={0} cellSpacing={0}>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
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
                {/* 国旗在名字前（2026-09-24 张老师要求，原排行有国旗图标）；
                    gif 已从 minesweepergame.com 下载到 public/images/flags/ */}
                <img
                  className="flag"
                  src={`/images/flags/${r.flag}.gif`}
                  alt={r.flag}
                  title={r.flag}
                  width={20}
                  height={13}
                />
                <span>{r.name}</span>
              </td>
              <td className="t">{r.beg}</td>
              <td className="t">{r.int}</td>
              <td className="t">{r.exp}</td>
              <td className="sum">{Math.round(parseFloat(r.sum))}</td>
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
