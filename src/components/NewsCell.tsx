// 动态单元格（服务端包装）：预算军衔称号后交给 NewsCellView 渲染

import { title as assessTitle, recordNewsExpTime } from "@/lib/assess";
import { getThunderKingThreshold } from "@/lib/title-system";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";

export async function NewsCell({ news }: { news: NewsItem }) {
  // 2026-11-06 张老师定：总司令=动态阈值档（快照快于阈值即评定，不再按身份特判）
  const kingTh = await getThunderKingThreshold();
  return (
    <NewsCellView
      news={news}
      title={assessTitle(recordNewsExpTime(news.expTime, news.details, news.videoRealTime), kingTh)}
    />
  );
}
