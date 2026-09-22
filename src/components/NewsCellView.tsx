// 动态单元格（展示部分，客户端可用）——军衔称号由服务端预算好以 title 传入
// 移植 views/news/_cell、_newbie、_person_record

import Link from "next/link";
import { LEVEL_NAMES, NEWS_TYPE, ORDER_NAMES, type Level, type Order } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import type { NewsItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";

function formatScore(order: string, value: number): string {
  return order === "3bvs" ? score3bvs(value) : scoreTime(value);
}

export function NewsCellView({ news, title }: { news: NewsItem; title: string }) {
  const d = news.details as { lv?: string; od?: string; or?: number; cr?: number };
  return (
    <tr>
      <td>
        {news.type === NEWS_TYPE.NEWBIE && news.author && (
          <>
            <AvatarCell id={news.author.id} name={news.author.chineseName} sex={news.author.sex} className="author" gender="small" link />
            <TitleBadge title={title} link />
            <em>正式入伍，开始扫雷生涯！</em>
          </>
        )}
        {news.type === NEWS_TYPE.PERSON_RECORD && news.author && (
          <>
            <AvatarCell id={news.author.id} name={news.author.chineseName} sex={news.author.sex} className="author" gender="small" link />
            <TitleBadge title={title} link />
            {(d.or ?? 0) > 0 ? "刷新了" : "创造了"}
            <span className="record person">
              个人{LEVEL_NAMES[(d.lv ?? "sum") as Level] ?? d.lv}
              {ORDER_NAMES[(d.od ?? "time") as Order] ?? d.od}
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
        {news.type !== NEWS_TYPE.NEWBIE && news.type !== NEWS_TYPE.PERSON_RECORD && (
          <em>{JSON.stringify(news.details)}</em>
        )}
      </td>
      <td>{timeOpposite(news.createTime, 86400, "Y-n-j")}</td>
    </tr>
  );
}
