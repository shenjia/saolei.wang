// 世界 TOP100 表格 + 底部标准翻页滑条（2026-10-15 张老师要求：替代原「加载更多」
// more_loader 版式，改用与排行/录像等列表同款 PageSlider；最右侧加「查看完整排行」
// 外链按钮，新窗口打开 minesweepergame.com 完整榜。数据由服务端一次性抓全（1 天缓存），
// 翻页纯本地切片，零请求）
// 2026-09-24 二轮：每级纪录后灰色括号日期；总成绩两位小数。
// 2026-09-24 六轮：Country/Name 合并一列（表头 Country / Name，国旗+空格+名字，左对齐）。
// 2026-09-24 五轮：纪录数字加粗 + 分级颜色与主排行榜一致（初 #999994/中 #bbbbaf/高 #ddddcf/总 #e6e6da）；
// 有录像文件的纪录可点击，经 /api/world/video 代理原站 avf 用站内 flop 播放器播放。

"use client";

import { useState } from "react";
import type { WorldRow } from "@/lib/worldtop";
import { WORLD_RANKING_PAGE } from "@/lib/worldtop";
import { PageSlider } from "./PageSlider";
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
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  // 换页纯本地切片（数据已全量在内存，零请求；越界自动钳回）
  const cur = Math.min(page, pages);
  const start = (cur - 1) * PAGE;

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
          {rows.slice(start, start + PAGE).map((r) => (
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
          page={cur}
          pages={pages}
          loading={false}
          onGoto={setPage}
          hasMore={false}
          onMore={() => {}}
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
    </>
  );
}
