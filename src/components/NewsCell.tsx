// 动态单元格（服务端包装）：预算军衔称号后交给 NewsCellView 渲染

import { title as assessTitle } from "@/lib/assess";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";

export async function NewsCell({ news }: { news: NewsItem }) {
  return <NewsCellView news={news} title={await assessTitle(news.userScore)} />;
}
