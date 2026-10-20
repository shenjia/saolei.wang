// 录像列表：级别筛选 + 表头排序 + 加载更多
// 2026-09-24 张老师要求：列表参考 2008 版版式（Video_All 紧凑行 → VideoTable），
// 页头参考排行榜版式——h1 与全部筛选器（级别 tabs + 排序 tabs）都放进主体卡片内部。
// 同日二轮：老式翻页（Pager）改「加载更多」（左右布局：左=总数 右=按钮）。
// 2026-09-26 张老师要求：页面改双栏（复用首页 #home two_columns 版式，主栏宽度与首页一致），
// 右栏新增「热门录像」（至少两条评论，按上传时间倒序）与「统计」两个板块。
// 2026-10-15 张老师要求：右侧排序 tabs 去掉，换搜索框（搜玩家=筛其录像；搜时间成绩=
// 匹配所有显示相同的成绩；输中文出推荐下拉，与排行搜索同体验）；
// 排序改表头点击（成绩/3BV/3BV/s/评论/点击/上传时间），默认上传时间且不高亮，
// 其余排序列高亮表头与对应数据。
// 2026-10-16 晚（张老师拍板「切换」）：主栏换客户端壳 VideoListSection——切级别筛选、
// 点表头排序就地生效不导航不跳顶；搜索框仍软导航（key=author-time 重挂载换数据）。
// 2026-10-20 张老师要求：去掉右栏「热门录像」与「统计」（热门录像移首页替换排行前十），
// 页面改通栏（与排行页同版式：.main 单卡片、62% 流式宽）。

import { getVideoList } from "@/lib/queries";
import { prisma } from "@/lib/db";
import {
  VIDEO_LEVELS,
  parseVideoListOrder,
  type VideoLevel,
  type VideoListOrder,
} from "@/lib/config";
import { VideoListSection } from "@/components/VideoListSection";

export const dynamic = "force-dynamic";
export const metadata = { title: "录像" };

function parseLevel(v?: string): VideoLevel | "all" {
  return (VIDEO_LEVELS as readonly string[]).includes(v ?? "") ? (v as VideoLevel) : "all";
}

export default async function VideoListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const level = parseLevel(sp.level);
  const order: VideoListOrder = parseVideoListOrder(sp.order);
  const author = sp.author ? parseInt(sp.author, 10) || undefined : undefined;
  // 时间成绩搜索输入（秒字符串，如 37.29；非法输入忽略）
  const time = sp.time?.trim() || undefined;
  // 3BV 搜索输入（整数字符串，如 42；非法输入忽略，2026-10-20）
  const bv = sp["3bv"]?.trim() || undefined;

  const [{ videos, total, pageSize }, authorName] = await Promise.all([
    getVideoList({ level, order, author, time, bv, page: 1 }),
    // 玩家筛选回显姓名（搜索框显示当前筛选）
    author
      ? prisma.user
          .findUnique({ where: { id: BigInt(author) }, select: { chineseName: true } })
          .then((u) => u?.chineseName)
      : Promise.resolve(undefined),
  ]);

  return (
    <div id="page" className="main video_old">
      {/* 页头（h1+级别 tabs+搜索框）与表格都在壳组件内：级别/排序就地切换，
          搜索走软导航（author/time/3bv 变化由壳内 key 重挂载换入新数据） */}
      <VideoListSection
        initial={videos}
        total={total}
        pageSize={pageSize}
        level={level}
        order={order}
        author={author}
        authorName={authorName}
        time={time}
        bv={bv}
      />
    </div>
  );
}
