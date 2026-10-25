// 录像「加载更多」增量接口：
// ① 默认（游标 cursor+size+level）——首页「最新录像」版块（2026-09-24，与 /api/news/more 同构；
//    2026-10-22 起排序键为 (create_time,id)，cursor 语义见分支内注释）
// ② 列表模式（page+level+order+author）——/video 列表页 + 用户主页录像版块，
//    与 getVideoList 的页码/筛选语义完全一致（复用同一查询，含成绩表排序切换）
// ③ 首页页码模式（feedPage+base+level，2026-10-14 四轮）——首页录像版块翻页条，
//    上传时间倒序按页取（getVideoFeedPage）；feedPage 与 ② 的 page 互不干扰
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染。

import { NextResponse } from "next/server";
import { getVideoFeed, getVideoFeedPage, getVideoCount, getVideoFeedCount, getVideoList } from "@/lib/queries";
import { getSession } from "@/lib/auth";
import {
  VIDEO_PAGESIZE,
  VIDEO_LEVELS,
  VIDEO_LIST_DIRS,
  parseVideoListOrder,
  type VideoLevel,
  type VideoListDir,
} from "@/lib/config";

function parseLevel(p: URLSearchParams): VideoLevel | "all" {
  const lv = p.get("level") ?? "";
  return (VIDEO_LEVELS as readonly string[]).includes(lv) ? (lv as VideoLevel) : "all";
}

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;

  // ② 列表模式：带 page 参数即走 getVideoList 页码语义
  const pageRaw = p.get("page");
  if (pageRaw) {
    // 2026-10-16：page 放行 1（原钳 ≥2——「加载更多」首页恒来自服务端渲染；
    // 用户主页录像版块 client 模式切筛选/排序需就地拉第 1 页整表替换。
    // 既有调用方（加载更多/滑条）只传 ≥2，行为不变）
    const page = Math.max(1, parseInt(pageRaw, 10) || 1);
    const level = parseLevel(p);
    // 2026-10-15：排序列扩为表头点击全集（parseVideoListOrder），并透传时间成绩搜索
    const order = parseVideoListOrder(p.get("order") ?? undefined);
    // 2026-10-23：排序方向（升降序切换）；非法值回 undefined → getVideoList 内按列默认方向
    const dirRaw = p.get("dir") ?? "";
    const dir: VideoListDir | undefined = (VIDEO_LIST_DIRS as readonly string[]).includes(dirRaw)
      ? (dirRaw as VideoListDir)
      : undefined;
    const author = parseInt(p.get("author") ?? "", 10) || undefined;
    const time = p.get("time")?.trim() || undefined;
    // 2026-10-20：透传 3BV 搜索（精确筛选）
    const bv = p.get("3bv")?.trim() || undefined;
    // 2026-10-20：透传 NF 筛选（只显示 NF 录像，开关在首页/列表页/用户主页录像版块）
    const nf = p.get("nf") === "1";
    // 2026-10-23 张老师需求：本人主页放行自己的屏蔽盘。服务端铁闸——banned=1 仅在
    // 「请求者本人 == author」时生效（他人/未登录带此参数一律忽略，防枚举他人屏蔽盘）
    let includeBanned = false;
    if (p.get("banned") === "1" && author) {
      const session = await getSession();
      includeBanned = !!session && session.uid === author;
    }
    // 每页条数：调用方自定义（用户主页录像版块传 20），默认 /video 列表的 20；
    // 上限 100（2026-10-14「加载更多」递增批量封顶放宽，原 50）。
    // 2026-10-26 修复「加载更多」跳行：size 语义改为「本批行数 take」（递增批量可 >20），
    // OFFSET 页锚点恒按 20——与客户端页码按 20/页推进（page = winStart + items.length/20）
    // 基准对齐（对齐 /api/bbs/more、/api/ranking/more 的 skip-锚定-base 模式）。
    // 原 OFFSET=(page-1)*size 在第 2 击起（size=40/80/100）跳过整段行，玩家按「加载更多」
    // 永远翻不到落在间隙里的录像（钱旭程 342344 案例）；hasMore 同步改按锚点页数计
    const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 100);
    const { videos, total, pageSize } = await getVideoList({
      level, order, dir, author, time, bv, nf, page, pageSize: size,
      ...(size > VIDEO_PAGESIZE ? { pageAnchor: VIDEO_PAGESIZE } : {}),
      ...(includeBanned ? { includeBanned: true } : {}),
    });
    return NextResponse.json({
      videos,
      total,
      // 已加载末位 = 页锚点偏移 + 本批行数；恰达 total 时必须报 false——
      // 若按 page*20 < total，批落在尾页非整倍处（如 160+90=250）会误判 true，
      // 再点一次按 Math.floor(250/20) 重算页码会重复拉已加载的尾段
      hasMore: (page - 1) * VIDEO_PAGESIZE + videos.length < total,
    });
  }

  // ③ 首页页码模式（feedPage）：id 倒序第 N 页起 size 条
  //  2026-10-23：首页发现流去重口径——(用户,级别) 配额 + 纪录盘保位（getVideoFeedPage 内实现），
  //  total 同步换 getVideoFeedCount 去重口径（与首页 SSR 同源同键，共享 60s 缓存）
  const feedPage = parseInt(p.get("feedPage") ?? "", 10);
  if (feedPage >= 1) {
    const level = parseLevel(p);
    const base = parseInt(p.get("base") ?? "", 10) || VIDEO_PAGESIZE;
    const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 100);
    // 2026-10-20：透传 NF 筛选（首页录像版块 NF 开关）
    const nf = p.get("nf") === "1";
    const [items, total] = await Promise.all([
      getVideoFeedPage({ level, page: feedPage, base, limit: size, nf }),
      getVideoFeedCount({ level, nf }),
    ]);
    return NextResponse.json({
      items,
      cursor: items.length ? items[items.length - 1].id : 0,
      count: items.length,
      total,
    });
  }

  // ① 首页游标模式（2026-10-22 排序键改 create_time）：cursorTime=上一批末条的
  // create_time（响应同名字段返回）。旧参数 cursor（录像id）与 (create_time,id) 序
  // 不兼容，不再作为续拉游标——携带旧 cursor 的请求自然取第 1 页（无当前调用方，
  // VideoFeed 已全量走 feedPage 页码模式）。
  //  2026-10-23 注：本分支保持全量口径（keyset 游标与去重配额不兼容），且当前无调用方——
  //  首页 SSR 与 feedPage 分支均已走去重口径；若未来启用需另行设计。
  const cursorTime = parseInt(p.get("cursorTime") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 100);
  const level = parseLevel(p);
  // 2026-10-20：透传 NF 筛选（首页录像版块 NF 开关）
  const nf = p.get("nf") === "1";

  const [items, total] = await Promise.all([
    getVideoFeed({ level, cursor: cursorTime || undefined, limit: size, nf }),
    // 同条件下的录像总数（左下角总数行）
    getVideoCount({ level, nf }),
  ]);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : 0,
    cursorTime: items.length ? items[items.length - 1].createTime : 0,
    count: items.length,
    total,
  });
}
