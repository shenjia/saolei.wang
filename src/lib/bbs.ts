// BBS 论坛（移植 2008 版 BBS/*：板块/主题/回复/置顶/精华/锁定/移动/删除 + UBB 渲染）

import { prisma } from "./db";
import { usersByIds, userTitleSnapshot, type UserBrief } from "./queries";
import { oldTitle, type OldTitle } from "./oldtitle";
import { dualTitles } from "./title-system";
import { NEWS_TYPE } from "./config";
import { publishNews } from "./news";
import { WX_FACES, FACE_BY_KEY } from "./faces";
import { decodeLegacyEntities, ubbExcerpt } from "./format";

/** 楼层引用摘要长度（2026-10-15 张老师定）：前 50 字，超出省略 */
export const REPLY_QUOTE_LIMIT = 50;

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

// 板块（移植 2008 版 Model 分类：公告/技术/杂谈/问答）
export const BBS_BOARDS = [
  { id: 0, key: "notice", name: "公告" },
  { id: 1, key: "skill", name: "技术" },
  { id: 2, key: "other", name: "杂谈" },
  { id: 3, key: "ask", name: "问答" },
] as const;
export const BBS_BOARD_NAMES: Record<number, string> = Object.fromEntries(
  BBS_BOARDS.map((b) => [b.id, b.name])
);

export const BBS_PAGESIZE = 19;
export const BBS_REPLY_PAGESIZE = 10;
export const BBS_TITLE_LIMIT = 100;
export const BBS_CONTENT_LIMIT = 5000;

// 排序文案（2026-09-24 张老师要求：去「按」前缀；「回复时间」改「更新时间」；
// 同日三轮：去掉「点击数/回复数」两种排序，只留时间类）
// 2026-09-25 六轮：排序筛选器已取消，列表固定更新时间排序（order="reply"）；
//   BBS_ORDERS/BbsOrder 保留供 getPostList 类型签名使用，页面不再暴露 order 参数
export const BBS_ORDERS = {
  reply: "更新时间",
  post: "发布时间",
} as const;
export type BbsOrder = keyof typeof BBS_ORDERS;

// ---------- UBB 渲染（移植 Models/Include/UBB.asp；先 HTML 转义再做白名单替换，杜绝注入） ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MINE_MAP: Record<string, string> = {
  " ": "Blank",
  ".": "Black",
  Q: "Block",
  "!": "Flag",
  "?": "Mark",
  "-": "Num",
  "+": "IsMine",
  "*": "Mine",
  X: "NoMine",
};

export function ubb(raw: string): string {
  // 2008 版 UBB 不做 HTML 转义直接输出，MSSQL 老数据里混有字面 <br> 与 &nbsp;（[&nbsp;] 是扫雷空格符号）
  // 转义前先把这些老遗留标记归一化，否则转义后会在页面上原样显示
  // 2026-10-15：老 ASP 入库转义的 &gt;/&lt;/&quot;/&amp;#N;（emoji）等实体同样在此统一解码
  // （decodeLegacyEntities），否则新站二次转义后页面显示 &gt;.&lt; 字面量（bbs/5264 实证）
  // 旧站链接重写（2026-09-25）：
  // ① 静态图热链：历史帖子里 36 处 [img]http://(www.)saolei.(net|wang)/Models/Images/…
  //    旧域名（net 已被抢注跳垃圾站、wang 未来下线）不可依赖 → 重写为新站本地路径
  //    /models/images/…（旧站 Models/Images 已全量拷到 public/models/images/，288 文件 ~8M）
  // ② 页面绝对链接：274 处 [url http://www.saolei.net/BBS/Title.asp?Id=1970/] 形态——
  //    域名改写成相对路径后交由 src/proxy.ts 的旧站 301 规则接管（.asp 请求全量拦截），
  //    Id/Page 等查询串原样保留，落在正确的帖子/玩家/录像页
  const normalized = decodeLegacyEntities(
    raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/\[&nbsp;\]/gi, "[ ]")
      .replace(
        /https?:\/\/(?:www\.)?saolei\.(?:net|wang)(\/models\/images\/[^\s\[\]"]+)/gi,
        (_m, p: string) => p.toLowerCase()
      )
      .replace(
        /https?:\/\/(?:www\.)?saolei\.(?:net|wang)(\/(?:player|bbs|video|ranking|news|message|about|download|guide|help|hero|team|world|update|history|online|main|index)[^\s\[\]"]*)/gi,
        (_m, p: string) => p
      )
  );
  let text = escapeHtml(normalized);
  // 标题/签名颜色 span（2013 legacy CSS 里有 .Title/.Sign/.Signest）
  text = text
    .replace(/\[Title\]/gi, '<span class="Title">')
    .replace(/\[\/Title\]/gi, "</span>")
    .replace(/\[Sign\]/gi, '<span class="Sign">')
    .replace(/\[\/Sign\]/gi, "</span>")
    .replace(/\[Signest\]/gi, '<span class="Signest">')
    .replace(/\[\/Signest\]/gi, "</span>");
  // 粗斜下划线
  text = text
    .replace(/\[b\]/gi, "<strong>")
    .replace(/\[\/b\]/gi, "</strong>")
    .replace(/\[i\]/gi, "<em>")
    .replace(/\[\/i\]/gi, "</em>")
    .replace(/\[u\]/gi, "<u>")
    .replace(/\[\/u\]/gi, "</u>");
  // 图片（转义后的引号是 &quot;，URL 中不可能有 < >）
  text = text.replace(/\[img\]([^\[\]]+?)\[\/img\]/gi, '<img align="top" src="$1">');
  // 链接：[url 地址]文字[/url] 与 [url]地址[/url]
  text = text.replace(
    /\[url\s+([^\[\]\s]+?)\]([^\[\]]*?)\[\/url\]/gi,
    '<a href="$1" target="_blank" rel="noreferrer">$2</a>'
  );
  text = text.replace(
    /\[url\]([^\[\]]+?)\[\/url\]/gi,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );
  // 引用
  text = text.replace(/\[quote\]/gi, "<blockquote>").replace(/\[\/quote\]/gi, "</blockquote>");
  // 引用块作者名高亮（2026-10-16 张老师三定）：回复引用头「用户名：」前缀亮灰（比正文亮一档）。
  // 只匹配块首短前缀（≤24 字符 + 全角冒号）；无冒号的手写引用不受影响。
  // 此时机内层仍是 UBB 文本（face/雷图在后面才转），[^<] 不会切进真实标签
  text = text.replace(/<blockquote>([^<]{1,24}?)：/g, '<blockquote><span class="quote_author">$1：</span>');
  // 表情（编码规则见 lib/faces.ts）：
  //   [face]N[/face]   旧版 QQ，纯数字 1-30 白名单 → face/N.gif（2 万存量帖焊死）
  //   [face]key[/face] 新版微信，语义 key 白名单 → face-wx/{slot}.png（顺序调整只动 faces.ts，不错配）
  //   [face]Nn[/face]  过渡期数字码（7 条站内测试帖，已迁移），渲染端容忍
  text = text.replace(/\[face\]([^\[\]]{1,20}?)\[\/face\]/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    // 语义 key（新版）
    const byKey = FACE_BY_KEY.get(lower);
    if (byKey) return `<img src="/images/face-wx/${byKey.slot}.png" alt="${byKey.zh}" title="${byKey.zh}">`;
    // 过渡码 Nn → 按槽位归一化渲染（N=1-30）
    const legacy = lower.match(/^(\d{1,2})n$/);
    if (legacy) {
      const slot = Math.min(30, Math.max(1, parseInt(legacy[1], 10)));
      const f = WX_FACES[slot - 1];
      return `<img src="/images/face-wx/${slot}.png" alt="${f.zh}" title="${f.zh}">`;
    }
    // 旧版纯数字（含 [face]30[/face] 修复语义，c1fd3ce）
    if (/^\d{1,2}$/.test(lower)) {
      const id = Math.min(30, Math.max(1, parseInt(lower, 10)));
      return `<img src="/images/face/${id}.gif" alt="">`;
    }
    return m; // 未知码原样透传（如正文里手打的 [face]xx[/face] 文字）
  });
  // 扫雷符号：[1]-[8] 数字格 + 功能格
  for (let i = 0; i <= 8; i++) {
    text = text.replaceAll(`[${i}]`, `<img src="/images/mine/${i}.gif" alt="${i}">`);
  }
  for (const [key, name] of Object.entries(MINE_MAP)) {
    text = text.replaceAll(`[${key}]`, `<img src="/images/mine/${name.toLowerCase()}.gif" alt="">`);
  }
  // 换行与制表
  const out = text.replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;").replace(/\r?\n/g, "<br>");
  // 摆雷图行（2026-09-24 张老师要求：纯雷图行行距为 0，多行 gif 拼成完整地图）
  // 连续纯雷图行（含行间的单个 <br>）合并包进 <div class="mine-map">：块内 line-height=16px=图高，行间零缝隙；
  // 空行（<br><br>）与文字行（含 [Title]/face 等）终止分组，保持正常正文行高
  const isMineOnly = (line: string) =>
    line.length > 0 && /^(\s|<img src="\/images\/mine\/[^"]*" alt="[^"]*">)+$/.test(line);
  const isBr = (p: string) => /^<br\s*\/?>$/.test(p);
  const parts = out.split(/(<br\s*\/?>)/);
  let result = "";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      result += `<div class="mine-map">${buf.join("")}</div>`;
      buf = [];
    }
  };
  parts.forEach((p, i) => {
    if (isMineOnly(p)) {
      buf.push(p);
      return;
    }
    // 组内行间 <br>：仅当下一段内容仍是纯雷图行时并入组，否则组到此为止
    if (isBr(p) && buf.length && isMineOnly(parts[i + 1] ?? "")) {
      buf.push(p);
      return;
    }
    flush();
    result += p;
  });
  flush();
  return result;
}

// ---------- 查询 ----------

/** 作者信息 + 军衔/旧版称号（2026-09-23 张老师要求：详情页人名旁带性别标记与军衔） */
export interface BbsAuthor extends UserBrief {
  /** 军衔（快照评定，TitleBadge 徽章用） */
  title: string;
  /** 旧版称号（按快照高级纪录+性别+在榜，Phase 5 观看者体系切换用） */
  old: OldTitle;
  /** 发布时是否在榜（快照；布衣=未加入排行） */
  ranked: boolean;
}

/** 军衔取数（2026-10-17 称号快照制）：按行内 exp_time 快照逐行评定，
 *  不再实时查 user_scores 当前值——同页同一用户的多条内容显示各自时刻的称号。
 *  Phase 5：old 同时按快照 ranked 判布衣；雷帝在 dualTitles 内判（此处复用 TitlePair.c） */
async function authorsFromSnapshots(
  rows: { user: number; expTime: number; ranked: boolean }[]
): Promise<Map<number, BbsAuthor>> {
  const ids = [...new Set(rows.map((r) => r.user).filter((x) => x > 0))];
  const briefs = await usersByIds(ids);
  const pairs = await dualTitles(
    rows.map((r) => ({
      userId: r.user,
      expTime: r.expTime,
      ranked: r.ranked,
      sex: briefs.get(r.user)?.sex ?? 1,
    }))
  ); // TitlePair：m 军衔 + c 旧称号（含雷帝判定）
  const out = new Map<number, BbsAuthor>();
  for (const r of rows) {
    if (r.user <= 0 || out.has(r.user)) continue;
    const b = briefs.get(r.user);
    if (!b) continue;
    const p = pairs.get(r.user);
    out.set(r.user, {
      ...b,
      title: p?.m ?? "",
      old: p?.c ? { name: p.c.name, color: p.c.color } : oldTitle(r.expTime, b.sex),
      ranked: r.ranked,
    });
  }
  return out;
}

export interface BbsPostItem {
  id: number;
  board: number;
  title: string;
  replies: number;
  clicks: number;
  /** 高亮（旧版 IsHigh 语义：仅标题白显，不参与排序；历史 172 条保留） */
  isTop: boolean;
  /** 置顶（新版真置顶：列表排序提前，2026-09-25 独立） */
  isPinned: boolean;
  isNice: boolean;
  isLocked: boolean;
  createTime: number;
  lastReplyTime: number;
  author: BbsAuthor | null;
}

export async function getPostList(opts: {
  board?: number;
  order: BbsOrder;
  nice?: boolean;
  /** 搜索关键字（2026-09-26 张老师要求）：匹配 主题标题 contains OR 作者人名（中/英 contains） */
  q?: string;
  page: number;
  /** 本批行数（2026-10-14「加载更多」递增批量）：skip 恒按 BBS_PAGESIZE 页锚点，take 才是行数 */
  take?: number;
}): Promise<{ posts: BbsPostItem[]; total: number; pageSize: number }> {
  const { board, order, nice, q, page } = opts;
  // 搜索态：作者 id 预查（人名匹配的用户集，take 100 截断——3.4 万用户下同名/热门词足够覆盖）
  const kw = (q ?? "").trim().slice(0, 30);
  let authorIds: bigint[] = [];
  if (kw) {
    const matched = await prisma.user.findMany({
      where: {
        OR: [{ chineseName: { contains: kw } }, { englishName: { contains: kw } }],
      },
      select: { id: true },
      take: 100,
    });
    authorIds = matched.map((u) => u.id);
  }
  const where = {
    status: 0,
    ...(kw
      ? {
          OR: [
            { title: { contains: kw } },
            ...(authorIds.length ? [{ user: { in: authorIds } }] : []),
          ],
        }
      : {}),
    ...(board !== undefined ? { board } : {}),
    ...(nice ? { isNice: true } : {}),
  };
  const total = await prisma.bbsPost.count({ where });
  // 旧版 IsHigh=「高亮」不参与排序（BBS_All/Page_List 仅按时间列），isTop 保持该语义；
  // 置顶由新列 isPinned 承担：置顶组在前、组内与普通帖同按时间列倒序（2026-09-25 张老师定）
  const orderField = order === "post" ? "id" : "lastReplyTime";
  const size = opts.take ?? BBS_PAGESIZE;
  const rows = await prisma.bbsPost.findMany({
    where,
    orderBy: [{ isPinned: "desc" }, { [orderField]: "desc" }],
    skip: (page - 1) * BBS_PAGESIZE, // 页锚点恒按 base 19（页码语义不变）
    take: size, // 本批行数（「加载更多」递增批量可 > 19）
  });
  const authors = await authorsFromSnapshots(
    rows
      .map((r) => ({ user: N(r.user), expTime: N(r.expTime), ranked: r.ranked === BigInt(1) }))
      .filter((x) => x.user > 0)
  );
  return {
    posts: rows.map((r) => ({
      id: N(r.id),
      board: r.board,
      // 老 ASP 入库转义的实体（&nbsp; 等）出口统一解码（2026-10-15，详见 format.ts decodeLegacyEntities）
      title: decodeLegacyEntities(r.title),
      replies: r.replies,
      clicks: r.clicks,
      // 公告板块（board=0）一律强制高亮（2026-09-25 张老师定）——展示层判定，
      // 不写库：同步重放与旧数据都不受影响；BbsOps 对公告隐藏「高亮」操作
      isTop: r.isTop || r.board === 0,
      isPinned: r.isPinned,
      isNice: r.isNice,
      isLocked: r.isLocked,
      createTime: N(r.createTime),
      lastReplyTime: N(r.lastReplyTime),
      author: authors.get(N(r.user)) ?? null,
    })),
    total,
    pageSize: BBS_PAGESIZE,
  };
}

export interface BbsPostDetail extends BbsPostItem {
  content: string;
}

/** 读主题并点击 +1（移植 Title_Check；编辑预载等场景传 bump=false 避免误计） */
export async function getPost(id: number, bump = true): Promise<BbsPostDetail | null> {
  const row = await prisma.bbsPost.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return null;
  if (bump) {
    await prisma.bbsPost.update({ where: { id: row.id }, data: { clicks: { increment: 1 } } });
  }
  const authors = await authorsFromSnapshots(
    [N(row.user)]
      .filter((x) => x > 0)
      .map((user) => ({ user, expTime: N(row.expTime), ranked: row.ranked === BigInt(1) }))
  );
  return {
    id: N(row.id),
    board: row.board,
    title: decodeLegacyEntities(row.title),
    content: row.content,
    replies: row.replies,
    clicks: row.clicks + (bump ? 1 : 0),
    // 公告板块强制高亮（同 getPostList 展示层判定）
    isTop: row.isTop || row.board === 0,
    isPinned: row.isPinned,
    isNice: row.isNice,
    isLocked: row.isLocked,
    createTime: N(row.createTime),
    lastReplyTime: N(row.lastReplyTime),
    author: authors.get(N(row.user)) ?? null,
  };
}

/** 楼层流条目（详情页首屏 + 「加载更多」共用）
 *  html 在服务端用 ubb() 预算好——客户端组件只渲染字符串，不引 ubb/Prisma；
 *  楼层号不入库（bbs_reply 无 floor 列），由展示层按顺序推得（1 楼是主题，见 BbsReplySection） */
export interface BbsReplyItem {
  id: number;
  createTime: number;
  author: BbsAuthor | null;
  html: string;
  /** UBB 剥标签纯文本摘要（≤50 字超出省略）——「回复」链接引用框预填用（2026-10-15） */
  excerpt: string;
}

/** 楼层流取数（cursor 语义，按 id 升序）
 *  2026-10-13 张老师要求：主题详情底部由「翻页」改「加载更多」，故从 page/skip 改为 id > cursor 取下一批；
 *  命中 @@index([post, status, id])，翻到底返回空数组即止 */
export async function getReplyFeed(
  postId: number,
  cursor = 0,
  size = BBS_REPLY_PAGESIZE
): Promise<{ items: BbsReplyItem[]; total: number }> {
  const total = await prisma.bbsReply.count({ where: { post: BigInt(postId), status: 0 } });
  const rows = await prisma.bbsReply.findMany({
    where: {
      post: BigInt(postId),
      status: 0,
      ...(cursor > 0 ? { id: { gt: BigInt(cursor) } } : {}),
    },
    orderBy: { id: "asc" },
    take: size,
  });
  const authors = await authorsFromSnapshots(
    rows.map((r) => ({ user: N(r.user), expTime: N(r.expTime), ranked: r.ranked === BigInt(1) }))
  );
  return {
    items: rows.map((r) => ({
      id: N(r.id),
      createTime: N(r.createTime),
      author: authors.get(N(r.user)) ?? null,
      html: ubb(r.content),
      excerpt: ubbExcerpt(r.content, REPLY_QUOTE_LIMIT),
    })),
    total,
  };
}

/** 最新主题（首页右栏用，移植 Title_Index_New；按发布时间取最新，置顶帖不掺入） */
export async function getLatestPosts(limit = 8): Promise<BbsPostItem[]> {
  const { posts } = await getPostList({ order: "post", page: 1 });
  return posts.filter((p) => !p.isPinned).slice(0, limit);
}

/** 加载更多（页码语义，BbsFeed 客户端组件 + /api/bbs/more 复用 getPostList） */
export async function getPostPage(opts: {
  board?: number;
  order: BbsOrder;
  nice?: boolean;
  q?: string;
  page: number;
  /** 本批行数（透传 getPostList；skip 恒按 BBS_PAGESIZE 页锚点） */
  take?: number;
}): Promise<{ posts: BbsPostItem[]; total: number; pageSize: number; hasMore: boolean }> {
  const r = await getPostList(opts);
  return { ...r, hasMore: opts.page * r.pageSize < r.total };
}

// ---------- 写操作 ----------

/** 发帖资格：已加入排行（任一级别有成绩，移植 2008 版「加入排行后才能发布主题」） */
export async function canPost(userId: number): Promise<boolean> {
  const row = await prisma.userScores.findUnique({
    where: { id: BigInt(userId) },
    select: { sumTime: true, begTime: true, intTime: true, expTime: true },
  });
  return !!row && (row.sumTime ?? 0) + (row.begTime ?? 0) + (row.intTime ?? 0) + (row.expTime ?? 0) > 0;
}

export async function createPost(userId: number, board: number, title: string, content: string): Promise<number> {
  const now = nowSec();
  // 事务内同发「论坛文章」动态（2026-09-24 张老师要求；仅个人主页可见，不进首页新闻流）
  return prisma.$transaction(async (tx) => {
    // 2026-10-17 称号快照制：发帖时刻 exp_time/ranked 内嵌本行
    const snap = await userTitleSnapshot(userId, tx);
    const row = await tx.bbsPost.create({
      data: {
        board,
        user: BigInt(userId),
        title,
        content,
        expTime: BigInt(snap.expTime),
        ranked: snap.ranked ? BigInt(1) : BigInt(0),
        lastReplyTime: now,
        lastReplyUser: BigInt(userId),
        createTime: now,
        updateTime: now,
      },
    });
    await publishNews({
      tx,
      type: NEWS_TYPE.ARTICLE,
      userId,
      reference: N(row.id),
      // cid = 主题 id：AI 后置复审据此精确撤下这条动态（同秒多条只靠 createTime 会误删）
      details: { t: title.slice(0, 50), cid: N(row.id) },
      createTime: N(now),
    });
    return N(row.id);
  });
}

export async function updatePost(
  id: number,
  userId: number,
  isAdmin: boolean,
  data: { title?: string; content?: string; board?: number }
): Promise<boolean> {
  const row = await prisma.bbsPost.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return false;
  if (!isAdmin && N(row.user) !== userId) return false;
  await prisma.bbsPost.update({
    where: { id: row.id },
    data: { ...data, updateTime: nowSec() },
  });
  return true;
}

/** 回帖（锁定帖仅管理员可回；事务更新计数与最后回复，移植 Title_Reply）
 *  2026-10-15 评论回复（张老师要求）：
 *  · quoteOf = 被回复楼层 id：内容前自动预拼 [quote]用户名：摘要[/quote] 引用头，
 *    客户端只传回复文字（引用框不可编辑），发布后成功给被回复者发通知
 *  · 返回被回复者 id（无引用或自回复时 null）——通知由 API 层落库后发 */
export async function createReply(
  postId: number,
  userId: number,
  content: string,
  isAdmin = false,
  quoteOf = 0
): Promise<{ id: number; quotedUserId: number | null } | "locked" | null> {
  const post = await prisma.bbsPost.findFirst({ where: { id: BigInt(postId), status: 0 } });
  if (!post) return null;
  if (post.isLocked && !isAdmin) return "locked";
  let full = content;
  let quotedUserId: number | null = null;
  let quotedName = "";
  let quotedExcerpt = "";
  if (quoteOf) {
    const q = await prisma.bbsReply.findFirst({
      where: { id: BigInt(quoteOf), post: BigInt(postId), status: 0 },
      select: { user: true, content: true },
    });
    if (q) {
      quotedUserId = N(q.user);
      const u = await prisma.user.findUnique({ where: { id: q.user }, select: { chineseName: true } });
      quotedName = u?.chineseName ?? "";
      quotedExcerpt = ubbExcerpt(q.content, REPLY_QUOTE_LIMIT);
      // 引用头格式与「回复」链接预填一致：用户名：前50字（超出省略号）
      full = `[quote]${quotedName}：${quotedExcerpt}[/quote]\n${content}`;
    }
  }
  const now = nowSec();
  // 事务内同发「评论」动态（BBS 回帖=评论文章，2026-09-24 张老师要求；仅个人主页可见）
  const replyId = await prisma.$transaction(async (tx) => {
    // 2026-10-17 称号快照制：回帖时刻 exp_time/ranked 内嵌本行
    const snap = await userTitleSnapshot(userId, tx);
    const reply = await tx.bbsReply.create({
      data: {
        post: BigInt(postId), user: BigInt(userId), content: full,
        expTime: BigInt(snap.expTime), ranked: snap.ranked ? BigInt(1) : BigInt(0),
        createTime: now, updateTime: now,
      },
    });
    await tx.bbsPost.update({
      where: { id: BigInt(postId) },
      data: { replies: { increment: 1 }, lastReplyTime: now, lastReplyUser: BigInt(userId) },
    });
    await publishNews({
      tx,
      type: NEWS_TYPE.COMMENT,
      userId,
      reference: postId,
      // cid = 回复 id：AI 后置复审据此精确撤下这条动态
      details: { kind: "bbs", t: post.title.slice(0, 50), cid: N(reply.id) },
      createTime: N(now),
    });
    return N(reply.id);
  });
  return { id: replyId, quotedUserId: quotedUserId === userId ? null : quotedUserId };
}

/** 删主题（软删；本人或管理员，移植 Title_Del / Del_My） */
export async function deletePost(id: number, userId: number, isAdmin: boolean): Promise<boolean> {
  const row = await prisma.bbsPost.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return false;
  if (!isAdmin && N(row.user) !== userId) return false;
  // 2026-10-22 张老师定：删帖级联回复（防孤儿回复——24396 案例主帖删后回复仍 status=0 残留）
  const ts = nowSec();
  await prisma.$transaction([
    prisma.bbsPost.update({ where: { id: row.id }, data: { status: -1, updateTime: ts } }),
    prisma.bbsReply.updateMany({ where: { post: row.id, status: 0 }, data: { status: -1, updateTime: ts } }),
  ]);
  return true;
}

/** 删回复（本人/楼主/管理员，移植 2008 版录像评论删除的权限语义） */
export async function deleteReply(id: number, userId: number, isAdmin: boolean): Promise<boolean> {
  const row = await prisma.bbsReply.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return false;
  const post = await prisma.bbsPost.findUnique({ where: { id: row.post } });
  if (!post) return false;
  if (!isAdmin && N(row.user) !== userId && N(post.user) !== userId) return false;
  await prisma.$transaction([
    prisma.bbsReply.update({ where: { id: row.id }, data: { status: -1, updateTime: nowSec() } }),
    prisma.bbsPost.update({ where: { id: row.post }, data: { replies: { decrement: 1 } } }),
  ]);
  return true;
}

/** 管理员：置顶/高亮/精华/锁定/移动板块（置顶=isPinned 新语义；高亮=isTop 旧版 IsHigh 语义） */
export async function adminSetPost(
  id: number,
  data: { isPinned?: boolean; isTop?: boolean; isNice?: boolean; isLocked?: boolean; board?: number }
): Promise<void> {
  await prisma.bbsPost.update({ where: { id: BigInt(id) }, data: { ...data, updateTime: nowSec() } });
}
