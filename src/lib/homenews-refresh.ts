// 首页动态缓存主动失效+即时重建（2026-11-06 张老师需求：管理员批量审核完录像后
// 动态立刻可见，不等 5 分钟 TTL）。
//
// ⚠️ 独立成文件的原因：queries.ts 会被客户端 bundle 引到（BbsFeed → bbs.ts →
// queries.ts 的 videoScores re-export），revalidateTag 顶层 import 会炸
// Pages/Client 编译（dev 实证 500，E394）。本模块只允许服务端链路 import。
//
// 覆盖三个条目（tag "home-news"，挂点在 queries.ts）：首页动态流（home-news-v1）、
// 新兵动态（home-newbies-v1）、首页动态总数（news-count-v9；板块计数条目一并
// 标脏、访问时按原 TTL 语义重建，无额外成本）。
// 流程 = revalidateTag 标脏（Next 16 两参形式，profile="max" = SWR 语义：
// 访客拿旧内容、重建走后台，永不阻塞）→ kickPreheat 合并窗口后后台重建
// （批量审核逐条触发只在最后一次 1s 后重建一次）。
// reviewVideo 可能被脚本/单测在无请求上下文直调——revalidateTag 抛错时吞掉，
// 兜底交给 5 分钟 TTL + 自驱预热，功能不劣化。

import { revalidateTag } from "next/cache";
import { kickPreheat } from "./preheat";

export function refreshHomeNewsCache(): void {
  try {
    revalidateTag("home-news", "max");
  } catch {
    // 非请求上下文（脚本直调 reviewVideo）无 work store，忽略
  }
  kickPreheat("home-news");
  kickPreheat("home-newbies");
  kickPreheat("news-count");
}
