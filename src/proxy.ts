// 旧站（2008 ASP 版 saolei.wang / saolei.net）URL → 新站 301 永久跳转
// 背景（2026-09-25 张老师要求）：论坛文章等旧地址 http://www.saolei.wang/BBS/Title.asp?Id=9786
// 被搜索引擎和外部帖子大量引用，上线新站后若不跳转，文章内容会「丢」。
//
// 方案：Next 16 proxy.ts（middleware 改名而来，见 node_modules/next/dist/docs）
//   统一在请求进入路由前做 301。所有跳转用「相对 Location」——
//   nginx 反代下 NextResponse.redirect(new URL(path, req.url)) 会把浏览器甩到内部
//   localhost:3100（req.url 是内部地址），见项目记忆「route handler 重定向坑」。
//
// 旧站 URL 特征：
//   - 路径大小写不敏感（IIS）：/bbs/title.asp 与 /BBS/Title.asp 等价 → 全部小写后匹配
//   - 查询串 GBK 编码（ASP 站点 charset=gb2312）：如 /Ranking/Ranking_Areas.asp?Area=<GBK>
//     NextRequest.searchParams 按 UTF-8 解码会得到乱码 → 对含中文的参数做 GBK 回退解码
//   - 分页参数 Page、排序参数 By、目标 Id：能映射的尽量透传

import { NextResponse, type NextRequest } from "next/server";

export const config = {
  // 只拦截 .asp 结尾的路径（含大小写混合）。旧站除此以外没有别的动态路径形态
  matcher: ["/:path*/:file*.asp", "/:file*.asp"],
};

/** 取查询参数（大小写不敏感，旧站 ASP Request() 即如此）：
 *  UTF-8 正常解码优先，含非 Latin-1 字符时回退 GBK 解码 */
function param(req: NextRequest, name: string): string | undefined {
  const lower = name.toLowerCase();
  let key: string | null = null;
  let v: string | null = null;
  for (const [k, val] of req.nextUrl.searchParams.entries()) {
    if (k.toLowerCase() === lower) {
      key = k;
      v = val;
      break;
    }
  }
  if (v == null || v === "") return undefined;
  // 检查 UTF-8 解码是否产生了「替换符/非 Latin-1」——GBK 中文按 UTF-8 解必乱
  const broken = [...v].some((ch) => {
    const c = ch.codePointAt(0)!;
    return c > 0xff || c === 0xfffd;
  });
  if (!broken) return v;
  // 从原始查询串手工按字节切分（searchParams 已把 %XX 解好，但解错了码）。
  // 注意 raw[0] 形如 "Area=%D5%E3%BD%AD"——去掉「key=」前缀须从首个 = 之后切
  const raw = req.nextUrl.search.match(new RegExp(`[?&]${key}=[^&]*`, "i"));
  if (!raw) return v;
  try {
    // 手工 percent-decode 回原始字节（decodeURIComponent 会按 UTF-8 解 GBK 字节直接抛异常）
    const hex = raw[0].slice(raw[0].indexOf("=") + 1);
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i++) {
      if (hex[i] === "%" && /^[0-9a-f]{2}$/i.test(hex.slice(i + 1, i + 3))) {
        bytes.push(parseInt(hex.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(hex.charCodeAt(i) & 0xff);
    }
    return new TextDecoder("gbk").decode(new Uint8Array(bytes));
  } catch {
    return v;
  }
}

/** 301 响应。
 *  必须用绝对 URL：Next 16 proxy 管线会 new URL(location) 解析 Location，
 *  相对路径直接 ERR_INVALID_URL（route handler 里可行的相对 Location 写法在这里 500）。
 *  绝对地址取 nginx 传来的 Host / X-Forwarded-Proto（dev=dev.saolei.wang，生产=线上域名），
 *  不用 req.url（那是内部 localhost:3100，会泄内部 host，见项目记忆重定向坑）。 */
function movedTo(req: NextRequest, location: string): NextResponse {
  const host = req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : req.url;
  return NextResponse.redirect(new URL(location, base), 301);
}

/** 数字参数解析（Id/Page/Rank 等），非法返回 undefined */
function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 旧排行 By 列名（Player_Beg_Time_Score 形态）→ 新 by 参数（beg_time 形态） */
function legacyRankingBy(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^Player_(Beg|Int|Exp|Sum)_(Time|3BVS)_Score$/i);
  if (!m) return undefined;
  return `${m[1].toLowerCase()}_${m[2].toLowerCase().replace("3bvs", "3bvs")}`;
}

/** 保留 Page 参数（新站 ranking/area/grow/click/bbs 详情等仍认 page） */
function withPage(base: string, page: number | undefined, extra?: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  if (extra) for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") qs.set(k, v);
  if (page != null && page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

export function proxy(req: NextRequest) {
  const url = req.nextUrl;
  // IIS 路径大小写不敏感，统一小写匹配
  const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const q = (n: string) => param(req, n);
  const id = () => num(q("id"));
  const page = () => num(q("page"));

  // ---------- BBS 论坛 ----------
  // /BBS/Title.asp?Id=9786 → /bbs/9786（张老师点名的核心案例）
  if (path === "/bbs/title.asp") {
    const n = id();
    // Page 透传：新站 /bbs/[id] 认 ?page=（回复分页）
    return movedTo(req, n ? withPage(`/bbs/${n}`, page()) : "/bbs");
  }
  // 板块列表：BBS_All=全部 BBS_Notice=公告 BBS_Skill=技术 BBS_Other=杂谈 BBS_Ask=问答
  // BBS_Hot=热门(无对应→全部) BBS_My=我的主题(需登录,无对应→全部) Index=全部
  const bbsBoards: Record<string, string | undefined> = {
    "/bbs/index.asp": undefined,
    "/bbs/index_new.asp": undefined,
    "/bbs/bbs_all.asp": undefined,
    "/bbs/bbs_notice.asp": "0",
    "/bbs/bbs_skill.asp": "1",
    "/bbs/bbs_other.asp": "2",
    "/bbs/bbs_ask.asp": "3",
    "/bbs/bbs_hot.asp": undefined,
    "/bbs/bbs_my.asp": undefined,
    "/bbs/index_nice.asp": "nice",
  };
  if (path in bbsBoards) {
    const b = bbsBoards[path]!;
    if (b === "nice") return movedTo(req, withPage("/bbs", undefined, { order: "nice" }));
    return movedTo(req, withPage("/bbs", page(), b ? { board: b } : undefined));
  }
  if (path === "/bbs/post.asp") return movedTo(req, "/bbs/post");
  if (path === "/bbs/edit.asp") {
    const n = id();
    return movedTo(req, n ? `/bbs/edit/${n}` : "/bbs");
  }

  // ---------- Video 录像 ----------
  if (path === "/video/show.asp") {
    const n = id();
    return movedTo(req, n ? `/video/${n}` : "/video");
  }
  // Video_All=全部 Video_Beg/Int/Exp=级别 Video_Hot=热门(无对应→全部)
  // My/My_Beg/My_Int/My_Exp=我的（Id=玩家）→ /video?author=Id&level=
  if (path === "/video/index.asp" || path === "/video/video_all.asp" || path === "/video/video_hot.asp" || path === "/video/new_index.asp") {
    return movedTo(req, withPage("/video", undefined, undefined));
  }
  const videoLevels: Record<string, string> = {
    "/video/video_beg.asp": "beg",
    "/video/video_int.asp": "int",
    "/video/video_exp.asp": "exp",
  };
  if (path in videoLevels) {
    return movedTo(req, withPage("/video", undefined, { level: videoLevels[path] }));
  }
  if (path === "/video/my.asp" || path === "/video/new_man.asp") {
    const n = id();
    return movedTo(req, n ? `/user/${n}` : "/video");
  }
  if (path === "/video/my_beg.asp" || path === "/video/my_int.asp" || path === "/video/my_exp.asp") {
    const n = id();
    const level = path.endsWith("my_beg.asp") ? "beg" : path.endsWith("my_int.asp") ? "int" : "exp";
    return movedTo(req, n ? withPage("/video", undefined, { author: String(n), level }) : "/video");
  }
  if (path === "/video/upload.asp" || path === "/video/upload_input.asp" || path === "/video/upload_select.asp" || path === "/video/upload_select_list.asp" || path === "/video/upload_ok.asp") {
    return movedTo(req, "/video/upload");
  }
  // 旧录像文件直链（2013 版起的 hash 路径）：/videos/... 已有 catch-all 路由，不在此处理；
  // 2008 早期路径 /Video/Mvf/70/xxx.mvf → /videos/Mvf/70/xxx.mvf
  if (path.startsWith("/video/mvf/")) {
    return movedTo(req, `/videos${url.pathname.slice("/video/mvf".length)}`);
  }

  // ---------- Player 玩家 ----------
  if (path === "/player/index.asp" || path === "/player/show.asp" || path === "/player/info.asp" || path === "/player/poster.asp" || path === "/player/main.asp") {
    const n = id();
    return movedTo(req, n ? `/user/${n}` : "/ranking");
  }
  if (path === "/player/star.asp") {
    // 每日一星（数据未迁移）→ 军衔页无意义；跳玩家详情或首页
    const n = id();
    return movedTo(req, n ? `/user/${n}` : "/");
  }
  if (path === "/player/random.asp") return movedTo(req, "/user/random");
  if (path === "/player/history_list.asp" || path === "/player/history_add.asp" || path === "/player/history_edit.asp") {
    const n = id();
    return movedTo(req, n ? `/user/${n}` : "/ranking");
  }
  if (path === "/player/login.asp") return movedTo(req, "/account/login");
  if (path === "/player/register.asp" || path === "/player/register_input.asp" || path === "/player/register_text.asp" || path === "/player/register_ok.asp") {
    return movedTo(req, "/account/register");
  }
  if (path === "/player/password.asp" || path === "/player/password_id.asp" || path === "/player/password_input.asp" || path === "/player/password_ok.asp" || path === "/player/password_fail.asp") {
    return movedTo(req, "/account/forgot");
  }
  if (path === "/player/manage.asp" || path === "/player/do_manage.asp" || path === "/player/do_manage_other.asp" || path === "/player/do.asp" || path === "/player/edit.asp" || path === "/player/more.asp" || path === "/player/satus.asp") {
    return movedTo(req, "/account/profile");
  }
  if (path === "/player/search.asp" || path === "/player/search_result.asp" || path === "/player/search_result_list.asp") {
    return movedTo(req, "/ranking");
  }

  // ---------- Ranking 排行 ----------
  if (path === "/ranking/index.asp" || path === "/ranking/ranking_all.asp") {
    return movedTo(req, withPage("/ranking", page(), { by: legacyRankingBy(q("by")) }));
  }
  if (path === "/ranking/ranking_nf.asp") {
    return movedTo(req, withPage("/ranking", page(), { view: "nf", by: legacyRankingBy(q("by")) }));
  }
  if (path === "/ranking/ranking_hero.asp") {
    // 神界榜已并入主榜（编制 41 人）→ 主榜按总计时间
    return movedTo(req, withPage("/ranking", page(), { by: "sum_time" }));
  }
  if (path === "/ranking/ranking_man.asp") {
    return movedTo(req, "/hero");
  }
  if (path === "/ranking/ranking_grow.asp" || path === "/ranking/top10_grow.asp") {
    return movedTo(req, "/grow");
  }
  if (path === "/ranking/ranking_click.asp" || path === "/ranking/top10_man.asp") {
    return movedTo(req, withPage("/click", page()));
  }
  if (path === "/ranking/ranking_area.asp") {
    return movedTo(req, "/area");
  }
  if (path === "/ranking/ranking_areas.asp") {
    const area = q("area");
    return movedTo(req, withPage("/area", page(), area ? { name: area } : undefined));
  }
  if (path === "/ranking/top10_world.asp" || path === "/ranking/top10_world_help.asp") {
    return movedTo(req, "/ranking?view=world");
  }
  if (path === "/ranking/top10_hero.asp") {
    return movedTo(req, "/hero");
  }
  if (path === "/ranking/goto.asp" || path === "/ranking/goto_list.asp") {
    // 名次直达（跳到对应玩家/页）——新站无此交互，落主榜
    return movedTo(req, "/ranking");
  }
  if (path === "/ranking/refresh.asp" || path === "/ranking/refresh_fail.asp" || path === "/ranking/action/goto_check_action.asp") {
    return movedTo(req, "/ranking");
  }

  // ---------- News 动态 ----------
  if (path === "/news/index.asp" || path === "/news/my.asp" || path === "/news/my_beg.asp" || path === "/news/my_int.asp" || path === "/news/my_exp.asp") {
    const n = id();
    return movedTo(req, n ? `/user/${n}` : "/");
  }
  if (path === "/news/hero.asp" || path === "/news/man.asp") {
    return movedTo(req, "/");
  }

  // ---------- Message 站内信 ----------
  if (path === "/message/box.asp" || path === "/message/list.asp" || path === "/message/notice.asp" || path === "/message/broad.asp" || path === "/message/broad_doing.asp") {
    return movedTo(req, "/message");
  }
  if (path === "/message/show.asp") {
    const n = id();
    return movedTo(req, n ? `/message/${n}` : "/message");
  }
  if (path === "/message/send.asp") {
    const n = id();
    return movedTo(req, n ? `/message?to=${n}` : "/message");
  }

  // ---------- 静态页 ----------
  if (path === "/about/index.asp") return movedTo(req, "/page/about");
  if (path === "/about/donate.asp") return movedTo(req, "/page/donate");
  if (path === "/about/team.asp") return movedTo(req, "/team");
  if (path === "/download/index.asp") return movedTo(req, "/page/download");
  if (path === "/guide/index.asp") return movedTo(req, "/page/guide");
  if (path === "/update/index.asp" || path === "/update/update.asp") return movedTo(req, "/page/history");
  if (path === "/history/2006.asp" || path === "/history/2007.asp" || path === "/history/2008.asp" || path === "/history/button.asp") {
    return movedTo(req, "/page/history");
  }
  if (path === "/world/index.asp" || path === "/world/world.asp" || path === "/world/hero.asp") return movedTo(req, "/titles");

  // Hero 雷神殿
  if (path === "/hero/index.asp") return movedTo(req, "/hero");

  // Team 管理团队
  if (path === "/team/index.asp") return movedTo(req, "/team");

  // ---------- Help 帮助 ----------
  const helpMap: Record<string, string> = {
    "/help/why.asp": "/page/help/why",
    "/help/grow.asp": "/page/help/grow",
    "/help/word.asp": "/page/help/word",
    "/help/video.asp": "/page/help/video",
    "/help/upload_rule.asp": "/page/help/upload",
    "/help/upload_3bv.asp": "/page/help/upload",
    "/help/freeze.asp": "/page/help/freeze",
    "/help/star.asp": "/page/help/star",
    "/help/question.asp": "/page/help/clone-faq",
    "/help/email.asp": "/page/help/email",
    "/help/bbs.asp": "/page/help/bbs",
    "/help/image.asp": "/page/help/avatar",
    "/help/ranking.asp": "/page/help",
    "/help/list.asp": "/page/help",
    "/help/title.asp": "/page/help",
  };
  if (path in helpMap) return movedTo(req, helpMap[path]);

  // ---------- 杂项 ----------
  if (path === "/index.asp" || path === "/main/index.asp" || path === "/main/satus.asp" || path === "/maintenance.asp") {
    return movedTo(req, "/");
  }
  if (path === "/title.asp") return movedTo(req, "/"); // 根目录 Title.asp=2008 录像迁移工具页
  if (path === "/online/game.asp" || path === "/online/game" || path === "/online/index.asp") {
    return movedTo(req, "/page/download"); // 在线 Java 扫雷已过时 → 下载页
  }
  if (path === "/error.asp" || path === "/error(source).asp") return movedTo(req, "/");
  if (path === "/try.asp") return movedTo(req, "/");

  // 兜底：未识别的 .asp → 首页（内容不丢，但无精确对应）
  return movedTo(req, "/");
}
