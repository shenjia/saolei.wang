// 动态单元格（展示部分，客户端可用）——军衔称号由服务端预算好以 title 传入
// 移植 views/news/_cell、_newbie、_person_record
// 2026-09-24 新增类型渲染：上传录像 VIDEO / 加入扫雷网 JOIN / 更换头像 AVATAR / 论坛文章 ARTICLE / 评论 COMMENT
// 2026-10-15 破纪录动态按行自适应：显示宽度不够放下一行时隐藏尾部段避免换行（张老师要求）
// 2026-10-16 破纪录动态改版（张老师定）：新成绩提到箭头前（金粗可点不变），箭头后改放绝对提升值（方案 B）

"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { LEVEL_NAMES, NEWS_TYPE, ORDER_NAMES, TITLES, TITLE_CLASSES, TITLE_CLASS_COLORS, TITLE_THRESHOLDS, type Level } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import type { NewsItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";
import { DeltaArrow } from "./RankingRows";

function formatScore(order: string, value: number): string {
  return order === "time" ? scoreTime(value) : score3bvs(value);
}

/** 提升值（2026-10-16 破纪录动态改版，张老师定）：|新-旧| 绝对量，正负号由箭头方向表达
    （五轮：去括号去+-，值前放小三角箭头）；时间 2 位小数、3BV/s 3 位小数（站点口径） */
function formatDelta(order: string, oldScore: number, newScore: number): string {
  const dv = Math.abs(newScore - oldScore) / 1000;
  return order === "time" ? dv.toFixed(2) : dv.toFixed(3);
}

/** 高级时间破纪录突破整数大关（SUB30~SUB100，2026-10-16 张老师定）：
    旧成绩所在 10s 大关下界，且新成绩已跨入关内（< 大关）才算突破。
    只认高级时间记录（军衔口径只看高级时间）；首创行旧成绩为 0，天然不出标签 */
function subMilestone(od: string | undefined, lv: string | undefined, oldMs: number, newMs: number): number | null {
  if (od !== "time" || lv !== "exp") return null;
  const gate = Math.floor(oldMs / 10000) * 10;
  if (gate < 30 || gate > 100) return null;
  if (newMs >= gate * 1000) return null;
  return gate;
}

/** SUB 大关标签颜色 = 该秒数对应军衔档的文字色（SUB40→元帅金、SUB50→少将亮橙、SUB60→少校暗橙…）。
    从 TITLE_THRESHOLDS 找第一个 ≥ 大关值的军衔，经 TITLE_CLASSES → TITLE_CLASS_COLORS 取色
    （与军衔体系单一数据源，改阈值/配色自动跟走） */
function subGateColor(gateSec: number): string {
  const i = TITLE_THRESHOLDS.findIndex((t) => t >= gateSec * 1000);
  const title = TITLES[i >= 0 ? i : TITLES.length - 1];
  return TITLE_CLASS_COLORS[TITLE_CLASSES[title] ?? ""] ?? "#b1b1a4";
}

export function NewsCellView({ news, title, classic }: { news: NewsItem; title: string; classic?: { name: string; color: string } | null }) {
  const d = news.details as {
    lv?: string;
    od?: string;
    or?: number;
    cr?: number;
    tm?: number;
    bv?: number;
    t?: string;
    kind?: string;
  };
  const authorCells = news.author && (
    <>
      <AvatarCell id={news.author.id} name={news.author.chineseName} sex={news.author.sex} className="author" gender="small" link />
      <TitleBadge title={title} classic={classic} link />
    </>
  );
  // SUB 大关（null = 本条不显示标签）：刷新纪录才判（首创行 or=0 旧成绩为大关外，天然 null）
  const subGate = subMilestone(d.od, d.lv, d.or ?? 0, d.cr ?? 0);

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
                {/* record_extra：宽度不够时整段隐藏（提升值），只留新成绩避免换行。
                    五轮张老师定：去括号去+-，值前放箭头小三角（时间▼=数值下降即更快、3BV/s ▲=更高），
                    颜色继承 .delta 金色，与排行页升降列同款箭头件 */}
                <span className="record_extra" ref={extraRef}>
                  <span className="delta">
                    <DeltaArrow dir={(d.od ?? "time") === "time" ? "down" : "up"} />
                    {formatDelta(d.od ?? "time", d.or!, d.cr!)}
                  </span>
                  {/* SUB 大关标签（2026-10-16 张老师定）：高级时间破纪录跨过 10s 整数大关时显示，
                      形态同首页论坛新帖 board_tag 徽章，字色 inline 按军衔档色传入；
                      置于 record_extra 内，窄屏自适应隐藏时与提升值一起收起 */}
                  {subGate && (
                    <span className="sub_tag" style={{ color: subGateColor(subGate) }}>
                      SUB {subGate}
                    </span>
                  )}
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
        {/* 晋升动态（type=53）已于 2026-10-17 张老师要求整体下线（存量已删、不再产生）；
            渲染块移除——details 的 ti/cond 字段随存量行一并消失 */}
        {![0, 10, 20, 21, 22, 30, 40, 50, 51, 52].includes(news.type) && (
          <em>{JSON.stringify(news.details)}</em>
        )}
      </td>
      <td className={"time " + (isRecent(news.createTime) ? "time--recent" : "time--old")}>
        {timeOpposite(news.createTime, TIME_YEAR, "Y-n-j")}
      </td>
    </tr>
  );
}
