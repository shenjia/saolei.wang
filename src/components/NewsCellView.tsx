// 动态单元格（展示部分，客户端可用）——军衔称号由服务端预算好以 title 传入
// 移植 views/news/_cell、_newbie、_person_record
// 2026-09-24 新增类型渲染：上传录像 VIDEO / 加入扫雷网 JOIN / 更换头像 AVATAR / 论坛文章 ARTICLE / 评论 COMMENT

import Link from "next/link";
import { LEVEL_NAMES, NEWS_TYPE, ORDER_NAMES, TITLE_CLASSES, titleConditionText, type Level } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import type { NewsItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";
import { RankBadge } from "./RankBadge";

function formatScore(order: string, value: number): string {
  return order === "time" ? scoreTime(value) : score3bvs(value);
}

/** 级别色类名（beg/int/exp 才挂，其余返回空串） */
function levelClass(lv?: string): string {
  return lv === "beg" || lv === "int" || lv === "exp" ? ` lv_${lv}` : "";
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
  return (
    <tr>
      <td>
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
            {/* 新成绩按级别变色（2026-10-14 张老师要求）：初级绿/中级橙/高级金，
                规则见 globals.css #news 区 .score.lv_* / .original.lv_*；
                lv 非 beg/int/exp（如总计）不挂类，保持 legacy 金/灰 */}
            {(d.or ?? 0) > 0 ? (
              <>
                <span className="original">{formatScore(d.od ?? "time", d.or!)}</span>
                <span className="increase"></span>
                <Link
                  href={`/video/${news.reference}`}
                  target="_blank"
                  className={"score" + levelClass(d.lv)}
                >
                  {formatScore(d.od ?? "time", d.cr!)}
                </Link>
              </>
            ) : (
              <Link
                href={`/video/${news.reference}`}
                target="_blank"
                className={"original" + levelClass(d.lv)}
              >
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
