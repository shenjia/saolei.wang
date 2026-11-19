// 首页动态缓存主动失效+即时重建（2026-11-06 张老师需求：管理员批量审核完录像后
// 动态立刻可见，不等 5 分钟 TTL）。
//
// ⚠️ 独立成文件的原因：queries.ts 会被客户端 bundle 引到（BbsFeed → bbs.ts →
// queries.ts 的 videoScores re-export），revalidateTag 顶层 import 会炸
// Pages/Client 编译（dev 实证 500，E394）。本模块只允许服务端链路 import。
//
// 覆盖条目：
// · tag "home-news"（挂点在 queries.ts）：首页动态流（home-news-v1）、新兵动态
//   （home-newbies-v1）、首页动态总数（news-count-v9；板块计数条目一并标脏、
//   访问时按原 TTL 语义重建，无额外成本）。
// · tag "home-video-feed"（挂点在 queries.ts，2026-11-09 张老师需求：一键过后首页
//   录像流自动更新）：发现流 id 集（feed-dedup-v3）、发现流总数（feed-dedup-count-v3）、
//   录像总数（video-count-v4）——屏蔽改变流成员/总数，必须随审核即时打脏。
// 流程 = revalidateTag 标脏 → kickPreheat 合并窗口后后台重建
// （批量审核逐条触发只在最后一次 1s 后重建一次）。
//
// ⚠️ 第二参必须 { expire: 0 } 而不是 "max"（2026-11-09 张老师报：一键过后首页新闻流
// 不更新，录像流正常——根因源码实证）：Next 16 的 revalidateTag(tag, "max") 只把
// tagsManifest.stale 标成 now、expired 写到 68 年后（max profile expire=∞），语义是
// 纯 SWR「标记-后台重建」——渲染请求读 unstable_cache 撞 stale 条目会**立即返回旧值**
// （unstable-cache.js：仅 isStaticGeneration 才 await 阻塞，首页 force-dynamic 不属于），
// router.refresh 拿到的仍是旧数据 → 新闻流 key 不变不重挂载，屏幕永远旧动态。
// { expire: 0 } 走 immediate-expiration 分支（expired=now），下次读缓存直接 miss →
// 渲染阻塞等重建、拿到新数据，refresh 一次即所见即所得。「立即过期」在 Server Action
// 里本该用 updateTag，但 updateTag 在 route handler 调用直接抛 E872（源码实证），
// 审核管线在 route handler 上下文，{ expire: 0 } 是唯一正确原语。
// reviewVideo 可能被脚本/单测在无请求上下文直调——revalidateTag 抛错时吞掉，
// 兜底交给 5 分钟 TTL + 自驱预热，功能不劣化。

import { revalidateTag } from "next/cache";
import { kickPreheat } from "./preheat";

export function refreshHomeNewsCache(): void {
  try {
    // 立即过期（见上方长注）：下次读缓存 miss，渲染阻塞重建拿新值
    revalidateTag("home-news", { expire: 0 });
    revalidateTag("home-video-feed", { expire: 0 });
  } catch {
    // 非请求上下文（脚本直调 reviewVideo）无 work store，忽略
  }
  kickPreheat("home-news");
  kickPreheat("home-newbies");
  kickPreheat("news-count");
  kickPreheat("video-feed-page1");
  kickPreheat("video-feed-count");
}
