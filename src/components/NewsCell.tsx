// 动态单元格（服务端包装）：预算军衔称号后交给 NewsCellView 渲染

import { title as assessTitle, recordNewsExpTime } from "@/lib/assess";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";

export async function NewsCell({ news }: { news: NewsItem }) {
  // 2026-11-06 张老师定方案 A：动态行内军衔一律按快照阈值评定（总司令特判只留大徽章/榜单）
  return (
    <NewsCellView
      news={news}
      title={assessTitle(recordNewsExpTime(news.expTime, news.details, news.videoRealTime))}
    />
  );
}
