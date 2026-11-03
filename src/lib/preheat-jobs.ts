// 一级页面缓存自驱动预热任务清单（2026-11-03，张老师提出「过期前 1 分钟自动重建」）
// 由 src/instrumentation.ts 在服务启动时加载（register()），模块级注册即调度。
//
// 口径：任务 = 首页访客路径的真实查询（与 src/app/page.tsx 的 Promise.all **同参**），
// 内部依赖（banned-ids / feed-dedup / video-list-join-count 等）随任务级联刷新、
// 各自的 TTL 时钟同样被重置。
// ⚠️ 两处同步维护：page.tsx 查询参数变化（如 getHotVideos(8) 的席位数、feed 的 base/limit）
//    或某条目 unstable_cache 的 revalidate 变化时，这里要同步改。
import { registerPreheat } from "./preheat";
import {
  getHomeNews,
  getNewbies,
  getHotVideos,
  getNewsCount,
  getVideoFeedPage,
  getVideoFeedCount,
  getSiteStats,
} from "./queries";
import { getThunderKingId } from "./title-system";
import { getPracticeToday } from "./practice";
import { HOME_VIDEO_NUMBER } from "./config";

// 以下 ttlSec 与 queries.ts / title-system.ts / practice.ts 对应条目的 revalidate 一致（均 300s）
registerPreheat("home-news", 300, () => getHomeNews());
registerPreheat("home-newbies", 300, () => getNewbies());
registerPreheat("hot-videos", 300, () => getHotVideos(8));
registerPreheat("news-count", 300, () => getNewsCount({ home: true }));
registerPreheat("video-feed-page1", 300, () =>
  getVideoFeedPage({ level: "all", page: 1, base: HOME_VIDEO_NUMBER, limit: HOME_VIDEO_NUMBER })
);
registerPreheat("video-feed-count", 300, () => getVideoFeedCount({ level: "all" }));
registerPreheat("site-stats", 300, () => getSiteStats());
registerPreheat("thunder-king", 300, () => getThunderKingId());
registerPreheat("practice-today", 300, () => getPracticeToday(null));
