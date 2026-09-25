// 动态单元格（展示部分，客户端可用）——军衔称号由服务端预算好以 title 传入
// 移植 views/news/_cell、_newbie、_person_record
// 2026-09-24 新增类型渲染：上传录像 VIDEO / 加入扫雷网 JOIN / 更换头像 AVATAR / 论坛文章 ARTICLE / 评论 COMMENT
// 2026-09-25 timeFirst：时间列挪到最左（仅首页试验，/video 与用户页不受影响）

import Link from "next/link";
import { LEVEL_NAMES, NEWS_TYPE, ORDER_NAMES, type Level } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import type { NewsItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";

function formatScore(order: string, value: number): string {
  return order === "time" ? scoreTime(value) : score3bvs(value);
}

export function NewsCellView({
  news,
  title,
  timeFirst,
}: {
  news: NewsItem;
  title: string;
  /** 时间列放最左（首页试验版式） */
  timeFirst?: boolean;
}) {
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
      <TitleBadge title={title} link />
    </>
  );
  return (
    <tr>
      {timeFirst && (
        <td className={"time " + (isRecent(news.createTime) ? "time--recent" : "time--old")}>
          {timeOpposite(news.createTime, TIME_YEAR, "Y-n-j")}
        </td>
      )}
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
            {(d.or ?? 0) > 0 ? (
              <>
                <span className="original">{formatScore(d.od ?? "time", d.or!)}</span>
                <span className="increase"></span>
                <Link href={`/video/${news.reference}`} target="_blank" className="score">
                  {formatScore(d.od ?? "time", d.cr!)}
                </Link>
              </>
            ) : (
              <Link href={`/video/${news.reference}`} target="_blank" className="original">
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
            <Link href={`/bbs/${news.reference}`} target="_blank" className="score" title={d.t ?? undefined}>
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
                <Link href={`/bbs/${news.reference}`} target="_blank" className="score" title={d.t ?? undefined}>
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
        {![0, 10, 20, 30, 40, 50, 51, 52].includes(news.type) && (
          <em>{JSON.stringify(news.details)}</em>
        )}
      </td>
      {!timeFirst && (
        <td className={"time " + (isRecent(news.createTime) ? "time--recent" : "time--old")}>
          {timeOpposite(news.createTime, TIME_YEAR, "Y-n-j")}
        </td>
      )}
    </tr>
  );
}
