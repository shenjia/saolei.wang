// 动态单元格（服务端包装）：预算军衔称号后交给 NewsCellView 渲染

import { title as assessTitle } from "@/lib/assess";
import { getThunderKingId } from "@/lib/title-system";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";

export async function NewsCell({ news }: { news: NewsItem }) {
  // 2026-10-19 总司令=雷界第一人特判（快照口径：按发布时刻是否榜首评定）
  const king = await getThunderKingId();
  return (
    <NewsCellView
      news={news}
      title={await assessTitle(news.expTime, king > 0 && king === (news.author?.id ?? 0))}
    />
  );
}
