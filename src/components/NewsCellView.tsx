// 动态单元格（展示部分，客户端可用）——军衔称号由服务端预算好以 title 传入
// 移植 views/news/_cell、_newbie、_person_record
// 2026-09-24 新增类型渲染：上传录像 VIDEO / 加入扫雷网 JOIN / 更换头像 AVATAR / 论坛文章 ARTICLE / 评论 COMMENT
// 2026-10-15 破纪录动态按行自适应：显示宽度不够放下一行时隐藏尾部段避免换行（张老师要求）
// 2026-10-16 破纪录动态改版（张老师定）：新成绩提到箭头前（金粗可点不变），箭头后改放绝对提升值（方案 B）

"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { LEVEL_NAMES, NEWS_TYPE, ORDER_NAMES, TITLE_CLASSES, titleConditionText, type Level } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import type { NewsItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";
import { RankBadge } from "./RankBadge";

function formatScore(order: string, value: number): string {
  return order === "time" ? scoreTime(value) : score3bvs(value);
}

/** 绝对提升值（2026-10-16 破纪录动态改版，张老师定方案 B）：新-旧。
    时间记负=更快（2 位小数，与 scoreTime 同精度）；3BV/s 记 +=更高（3 位小数，站点口径） */
function formatDelta(order: string, oldScore: number, newScore: number): string {
  const dv = (newScore - oldScore) / 1000;
  const sign = dv > 0 ? "+" : "";
  return order === "time" ? `${sign}${dv.toFixed(2)}` : `${sign}${dv.toFixed(3)}`;
}

export function NewsCellView({ news, title }: { news: NewsItem; title: string }) {
  const d = news.details as {
    lv?: string;
    od?: string;
    or?: number;
    cr?: number;
    tm?: number;
    bv?: number;
    t?: string;
    kind?: string;
    /** 晋升军衔名（type=53） */
    ti?: string;
    /** 晋升条件文案（type=53，如「高级记录 < 40秒」） */
    cond?: string;
  };
  const authorCells = news.author && (
    <>
      <AvatarCell id={news.author.id} name={news.author.chineseName} sex={news.author.sex} className="author" gender="small" link />
      <TitleBadge title={title} link />
    </>
  );

  // 破纪录行按行自适应（2026-10-15）：离屏克隆整格内容量单行宽度，放不下则隐藏箭头+提升值。
  // 克隆用 absolute+nowrap，不参与表格布局（table-layout:auto 改真节点会牵动整表列宽抖动）；
  // 行宽变化（窗口缩放/翻页换列宽）由 ResizeObserver 兜底重测
  const cellRef = useRef<HTMLTableCellElement>(null);
  const extraRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const cell = cellRef.current;
    const extra = extraRef.current;
    if (!cell || !extra) return;

    const evaluate = () => {
      const ghost = document.createElement("span");
      ghost.style.position = "absolute";
      ghost.style.visibility = "hidden";
      ghost.style.whiteSpace = "nowrap";
      for (const node of Array.from(cell.childNodes)) ghost.appendChild(node.cloneNode(true));
      // 始终按完整内容（含箭头+提升值）量宽：克隆会带上隐藏时的 inline display:none
      const ghostExtra = ghost.querySelector(".record_extra") as HTMLElement | null;
      if (ghostExtra) ghostExtra.style.display = "";
      cell.appendChild(ghost);
      const cs = getComputedStyle(cell);
      const avail = cell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const overflow = ghost.offsetWidth > avail + 1;
      ghost.remove();
      extra.style.display = overflow ? "none" : "";
    };

    evaluate();
    const ro = new ResizeObserver(evaluate);
    ro.observe(cell);
    // 字体晚到会改变文字宽度，加载完再校一次
    document.fonts?.ready.then(evaluate);
    return () => {
      ro.disconnect();
      extra.style.display = "";
    };
  }, []);

  return (
    <tr>
      <td ref={cellRef}>
        {news.type === NEWS_TYPE.NEWBIE && news.author && (
          <>
            {authorCells}
            <em>正式入伍，开始扫雷生涯！</em>
          </>
        )}
        {news.type === NEWS_TYPE.PERSON_RECORD && news.author && (
          <>
            {authorCells}
            {(d.or ?? 0) > 0 ? "刷新了" : "创造了"}
            <span className="record person">
              {LEVEL_NAMES[(d.lv ?? "sum") as Level] ?? d.lv}
              {/* od 非法时按 3bvs 兜底显示（历史脏数据防御） */}
              {(d.od ?? "") === "time" ? ORDER_NAMES.time : ORDER_NAMES["3bvs"]}
            </span>
            {/* 新成绩配色（2026-10-16 四轮张老师试色）：亮灰 #b1b1a4 加粗（record_score），
                提升值金 #fdc61a——颜色对调试验轮；「创造了」首创行同亮灰保持一致。
                首创行此前 2026-10-14 曾定金色，如要回退只改本注释与 CSS 即可 */}
            {(d.or ?? 0) > 0 ? (
              <>
                {/* 2026-10-16 张老师定：新成绩在前可点，后跟绝对提升值
                    （formatDelta：时间负=更快、3BV/s +=更高；三轮已去箭头） */}
                <Link href={`/video/${news.reference}`} target="_blank" className="score record_score">
                  {formatScore(d.od ?? "time", d.cr!)}
                </Link>
                {/* record_extra：宽度不够时整段隐藏（提升值），只留新成绩避免换行 */}
                <span className="record_extra" ref={extraRef}>
                  <span className="delta">（{formatDelta(d.od ?? "time", d.or!, d.cr!)}）</span>
                </span>
              </>
            ) : (
              <Link href={`/video/${news.reference}`} target="_blank" className="score record_score">
                {formatScore(d.od ?? "time", d.cr!)}
              </Link>
            )}
          </>
        )}
        {news.type === NEWS_TYPE.VIDEO && news.author && (
          <>
            {authorCells}
            上传了
            <span className="record person">{LEVEL_NAMES[(d.lv ?? "sum") as Level] ?? d.lv}录像</span>
            <Link href={`/video/${news.reference}`} target="_blank" className="score">
              {scoreTime(d.tm ?? 0)}
            </Link>
          </>
        )}
        {news.type === NEWS_TYPE.JOIN && news.author && (
          <>
            {authorCells}
            <em>加入扫雷网，成为雷界一员！</em>
          </>
        )}
        {news.type === NEWS_TYPE.AVATAR && news.author && (
          <>
            {authorCells}
            <em>更换了头像</em>
          </>
        )}
        {news.type === NEWS_TYPE.ARTICLE && news.author && (
          <>
            {authorCells}
            发表了
            <Link
              href={`/bbs/${news.reference}`}
              target="_blank"
              className="score news_article"
              title={d.t ?? undefined}
            >
              《{d.t ?? "未命名"}》
            </Link>
          </>
        )}
        {news.type === NEWS_TYPE.COMMENT && news.author && (
          <>
            {authorCells}
            {d.kind === "bbs" ? (
              <>
                评论了文章
                <Link
                  href={`/bbs/${news.reference}`}
                  target="_blank"
                  className="score news_article"
                  title={d.t ?? undefined}
                >
                  《{d.t ?? "未命名"}》
                </Link>
              </>
            ) : (
              <>
                评论了一盘
                <Link href={`/video/${news.reference}`} target="_blank" className="score">
                  录像
                </Link>
              </>
            )}
          </>
        )}
        {news.type === NEWS_TYPE.PROMOTION && news.author && (
          <>
            {authorCells}
            <span className="promoted">晋升了！</span>
            <span className="increase increase--gold" aria-hidden="true"></span>
            <span className="record person" data-tip={d.ti ? titleConditionText(d.ti) : undefined}>
              <RankBadge title={d.ti ?? ""} /> <em className={TITLE_CLASSES[d.ti ?? ""] ?? ""}>{d.ti ?? ""}</em>
            </span>
          </>
        )}
        {![0, 10, 20, 21, 22, 30, 40, 50, 51, 52, 53].includes(news.type) && (
          <em>{JSON.stringify(news.details)}</em>
        )}
      </td>
      <td className={"time " + (isRecent(news.createTime) ? "time--recent" : "time--old")}>
        {timeOpposite(news.createTime, TIME_YEAR, "Y-n-j")}
      </td>
    </tr>
  );
}
