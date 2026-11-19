// 世界 TOP100：抓取 minesweepergame.com 世界排行（2026-09-23 张老师提供接口；当晚要求从 TOP10 扩到 TOP100）
// 缓存 1 天（unstable_cache revalidate=86400），降低抓取频率；
// 接口对裸 curl 返回 403，必须带浏览器 UA + Referer；start=0 单页即返回 1-100 名。

import { unstable_cache } from "next/cache";
import { GEO_COUNTRIES, GEO_MINI } from "@/lib/world-map-geo";

const URL = "https://minesweepergame.com/common/ajax/ajax-ranking-world.php?rid=1&start=0&sort=0";
export const WORLD_RANKING_PAGE = "https://minesweepergame.com/world-rankings.php";
export const WORLD_FILE_BASE = "https://minesweepergame.com/member/file";
export const WORLD_TOP_LIMIT = 100;

export interface WorldRow {
  rank: number;
  flag: string; // 国旗代码（china/poland/...），中国行高亮
  pid: string; // 原站玩家 ID（profile.php?pid=；录像文件也在 member/file/{pid}/ 下）
  name: string;
  beg: string;
  begDate: string; // 初级纪录日期（2020-01-31，原站每个纪录后灰色括号显示）
  int: string;
  intDate: string;
  exp: string;
  expDate: string;
  sum: string;
  begVid: string; // 初级纪录录像文件名（原站 member/file/{pid}/{文件名}，无则为空）
  intVid: string;
  expVid: string;
}

export interface WorldTop {
  rows: WorldRow[];
  fetchedAt: number; // 抓取时间戳（ms），页面显示「更新时间」
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

function parse(html: string): WorldRow[] {
  const rows: WorldRow[] = [];
  // 每位玩家一个 <tr>：名次 / 国旗+头像 / 姓名 / 空 / 初级(链接) / 日期 / 中级 / 日期 / 高级 / 日期 / 总计
  // 国旗代码可能含连字符（united-states/south-korea 等），用 [\w-]+ 匹配
  const trRe = /<tr><td align='center'>(\d+)<\/td><td><img src='image\/flags\/([\w-]+)\.gif'>[\s\S]*?<\/td><td>([\s\S]*?)<\/td><td><\/td>([\s\S]*?)(?=<tr>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const [, rank, flag, nameHtml, rest] = m;
    // 三级成绩各在一个 text-align:right 单元格：新成绩是 <a> 链接（onclick=parseVideo('pid','文件名')），
    // 老成绩可能是纯文本（无录像文件）；纪录日期在成绩右侧灰色格（text-align:center + color:grey）。
    // pid 在国旗格的 profile 链接里（profile.php?pid=7872），不在姓名格——从整行抠
    const pid = /pid=(\d+)/.exec(m[0])?.[1] ?? "";
    const cells = [...rest.matchAll(/<td style='text-align:right;'>([\s\S]*?)<\/td>/g)].map((x) =>
      stripTags(x[1])
    );
    const vids = [...rest.matchAll(/parseVideo\('(\d+)','([^']+)'\)/g)].map((x) =>
      x[1] === pid ? x[2] : ""
    );
    const dates = [...rest.matchAll(/color:grey[^>]*>([\d-]+)</g)].map((x) => x[1]);
    const sumM = /<td style='text-align:center;'>(\d+(?:\.\d+)?)<\/td>/.exec(rest);
    if (cells.length < 3 || cells.slice(0, 3).some((c) => !/^\d+\.\d+$/.test(c)) || !sumM) continue;
    rows.push({
      rank: parseInt(rank, 10),
      flag,
      pid,
      name: stripTags(nameHtml),
      beg: cells[0],
      begDate: dates[0] ?? "",
      int: cells[1],
      intDate: dates[1] ?? "",
      exp: cells[2],
      expDate: dates[2] ?? "",
      sum: sumM[1],
      begVid: vids[0] ?? "",
      intVid: vids[1] ?? "",
      expVid: vids[2] ?? "",
    });
    if (rows.length >= WORLD_TOP_LIMIT) break;
  }
  return rows;
}

async function fetchWorldTop(): Promise<WorldTop | null> {
  try {
    const res = await fetch(URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: "https://minesweepergame.com/",
      },
      // 2026-10-14 加超时：原来无 signal，原站不响应时这次请求会一直挂着
      // （缓存为空或过期后由本次访问承担抓取，挂死即拖住一个请求）。8s 足够正常抓取，
      // 超时抛 TimeoutError → 被下面 catch 吞掉 → 返回 null → 组件显示降级文案。
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const rows = parse(await res.text());
    if (!rows.length) return null;
    return { rows, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

/** 世界 TOP100（1 天缓存；抓取失败返回 null，由组件降级显示） */
// 缓存键带版本号：解析逻辑变更后需丢弃旧缓存
// v2: 国旗连字符/纯文本成绩修复；v3: 三级纪录日期；v4: pid+录像文件名（首版 pid 提取有 bug）；
// v5: pid 改从整行提取（profile 链接在国旗格不在姓名格）——注意 unstable_cache 文件持久化，
// 改解析逻辑必须升版本号，dev 重启不会清缓存
export const getWorldTop100 = unstable_cache(fetchWorldTop, ["world-top100-v5"], {
  revalidate: 86400,
  tags: ["world-top100"],
});

// ==================== 世界地图 · 全量榜单按国籍聚合（2026-10-15 张老师需求） ====================
// 地图悬停气泡需要「该国参与排行玩家人数 + 领军人物」——原站 ajax 可分页翻全量
// （100/页，2026-10-13 实测 4412 名 / 93 国，45 页），与地区榜同公式按国籍聚合：
//   power = Σ（世界总人数 − 个人世界名次）
// 抓取策略（张老师定「一天一次」）：缓存 1 天；冷缓存重建时 5 并发拉全部分页。
// 中国口径：chinese-taipei 旗帜并入 CHN（我国标准口径，地图不单列台湾）。

/** 国旗 slug → ISO A3（world-map-geo.ts 的国家以 ISO A3 为 key） */
export const FLAG_ISO: Record<string, string> = {
  albania: "ALB", algeria: "DZA", argentina: "ARG", armenia: "ARM",
  australia: "AUS", austria: "AUT", bangladesh: "BGD", belarus: "BLR",
  belgium: "BEL", bolivia: "BOL", "bosnia-herzegovina": "BIH", brazil: "BRA",
  bulgaria: "BGR", canada: "CAN", chile: "CHL", china: "CHN",
  "chinese-taipei": "CHN", colombia: "COL", "costa-rica": "CRI", croatia: "HRV",
  cuba: "CUB", cyprus: "CYP", "czech-republic": "CZE", denmark: "DNK",
  "dominican-republic": "DOM", ecuador: "ECU", egypt: "EGY", estonia: "EST",
  fiji: "FJI", finland: "FIN", france: "FRA", germany: "DEU",
  greece: "GRC", guatemala: "GTM", hungary: "HUN", iceland: "ISL",
  india: "IND", indonesia: "IDN", iran: "IRN", iraq: "IRQ",
  ireland: "IRL", israel: "ISR", italy: "ITA", japan: "JPN",
  jordan: "JOR", kazakhstan: "KAZ", "korea-north": "PRK", "korea-south": "KOR",
  lebanon: "LBN", lithuania: "LTU", luxembourg: "LUX", macedonia: "MKD",
  madagascar: "MDG", malaysia: "MYS", malta: "MLT", mauritius: "MUS",
  mexico: "MEX", mongolia: "MNG", montenegro: "MNE", morocco: "MAR",
  nepal: "NPL", netherlands: "NLD", "new-zealand": "NZL", norway: "NOR",
  pakistan: "PAK", palestine: "PSE", peru: "PER", philippines: "PHL",
  poland: "POL", portugal: "PRT", romania: "ROU", russia: "RUS",
  serbia: "SRB", singapore: "SGP", slovakia: "SVK", slovenia: "SVN",
  "south-africa": "ZAF", spain: "ESP", "sri-lanka": "LKA", sweden: "SWE",
  switzerland: "CHE", syria: "SYR", thailand: "THA", tunisia: "TUN",
  turkey: "TUR", ukraine: "UKR", "united-arab-emirates": "ARE",
  "united-kingdom": "GBR", "united-states": "USA", uruguay: "URY",
  uzbekistan: "UZB", venezuela: "VEN", vietnam: "VNM",
};

export interface WorldCountryDatum {
  /** ISO A3（地图几何 key） */
  iso: string;
  /** 国家中文名（我国通用译名，来自 world-map-geo） */
  name: string;
  /** 综合排行名次（按指数降序） */
  rank: number;
  /** 参与排行玩家人数 */
  players: number;
  /** 综合排行指数：Σ（世界总人数 − 个人名次） */
  power: number;
  /** 领军人物姓名 */
  bestName: string;
  /** 领军人物世界排名 */
  bestRank: number;
  /** 领军人物总成绩（秒，两位小数显示用字符串） */
  bestSum: string;
}

export interface WorldCountryStats {
  countries: WorldCountryDatum[];
  fetchedAt: number;
}

const FULL_PAGE = "https://minesweepergame.com/common/ajax/ajax-ranking-world.php?rid=1&start=%d&sort=0";
// 并发 3（源站对 5 并发会出现 >8s 的 TTFB 超时）、单页超时 15s、失败重试 1 次
// ——全量抓取一天只跑一次，慢一点无妨，口径完整性优先
const FULL_CONCURRENCY = 3;
const FULL_TIMEOUT = 15000;

/** 拉一页（start 起 100 行）；返回行数组与榜单总量（最后一名名次） */
async function fetchPage(start: number): Promise<{ rows: WorldRow[]; total: number } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(FULL_PAGE.replace("%d", String(start)), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Referer: "https://minesweepergame.com/",
        },
        signal: AbortSignal.timeout(FULL_TIMEOUT),
      });
      if (!res.ok) {
        console.error(`[worldtop] fetchPage(${start}) HTTP ${res.status}${attempt ? "（重试后）" : "，重试一次"}`);
        if (attempt) return null;
        continue;
      }
      const html = await res.text();
      const rows = parse(html);
      if (!rows.length) {
        console.error(
          `[worldtop] fetchPage(${start}) 解析 0 行（HTTP ${res.status}，${html.length} 字节）${attempt ? "（重试后）" : "，重试一次"}`,
        );
        if (attempt) return null;
        continue;
      }
      // 总量 = 本页最后一名的名次（页不满 100 行即末页）
      return { rows, total: rows[rows.length - 1].rank };
    } catch (e) {
      // 超时 / 网络异常（此前静默返回 null 导致整次聚合莫名降级，2026-10-15 实证）
      console.error(`[worldtop] fetchPage(${start}) 异常: ${e}${attempt ? "（重试后放弃）" : "，重试一次"}`);
      if (attempt) return null;
    }
  }
  return null;
}

/** 探测全榜末位名次：指数跳抓 + 二分收缩。满页（100 行）说明末页在更后面；
    短页（0 < 行数 < 100）即末页，其最后一名名次 = 全榜总人数；空页说明已越过
    末页（指数跳可能直接跨过短页），需二分回头找。 */
async function probeWorldTotal(): Promise<number | null> {
  let lo = 0; // 已知满页起点（第一页 start=0 必满）
  let cur = 100;
  let step = 1000;
  for (let i = 0; i < 20; i++) {
    const p = await fetchPage(cur);
    if (p && p.rows.length < 100) return p.total; // 短页 = 末页
    if (p) {
      lo = cur;
      cur += step;
      step *= 2;
      continue;
    }
    // 空页（或网络失败）：越过末页，二分收缩 (lo, cur) 找末页起点
    let hi = cur;
    while (lo + 100 < hi) {
      const mid = lo + Math.floor((hi - lo) / 200) * 100;
      const mp = await fetchPage(mid);
      if (mp && mp.rows.length < 100) return mp.total;
      if (mp) lo = mid;
      else hi = mid;
    }
    // lo 是最后一个满页起点；末页 = lo+100（总人数恰为整百时该页为空，当日降级隐藏地图）
    const last = await fetchPage(lo + 100);
    return last ? last.total : null;
  }
  return null; // 探边上限兜底
}

/** 全量国家统计：先探边定全榜总量，再 5 并发拉全部分页；聚合时同步记录每国
    名次最靠前的行（领军人物姓名/总成绩直接可用）。
    指数口径与地区榜同款：Power = Σ（全榜总人数 − 个人世界名次） */
async function fetchWorldCountryStats(): Promise<WorldCountryStats | null> {
  try {
    const first = await fetchPage(0);
    if (!first) return null;
    const total = await probeWorldTotal();
    if (!total || total <= first.rows.length) {
      console.error(`[worldtop] 探边异常: total=${total}, 首页行数=${first.rows.length}`);
      return null; // 探边失败/单页榜：降级
    }
    const acc = new Map<string, { players: number; power: number; best: WorldRow }>();
    const absorb = (rows: WorldRow[]) => {
      for (const r of rows) {
        const iso = FLAG_ISO[r.flag];
        if (!iso) continue; // 未知旗帜：不入聚合（几何图上也无对应国家）
        const cur = acc.get(iso);
        if (cur) {
          cur.players += 1;
          cur.power += total - r.rank;
          if (r.rank < cur.best.rank) cur.best = r;
        } else {
          acc.set(iso, { players: 1, power: total - r.rank, best: r });
        }
      }
    };
    absorb(first.rows);
    const starts: number[] = [];
    for (let s = 100; s < total; s += 100) starts.push(s);
    for (let i = 0; i < starts.length; i += FULL_CONCURRENCY) {
      const batch = starts.slice(i, i + FULL_CONCURRENCY);
      const pages = await Promise.all(batch.map(fetchPage));
      for (const p of pages) {
        if (!p) return null; // 任一分页失败：整体降级（不做残缺聚合，口径必须完整）
        absorb(p.rows);
      }
    }
    // 中文名从几何数据取（我国通用译名）：主图国 + 小国引线圆点（SGP/MLT/MUS 只在
    // GEO_MINI 有名）；无名的国家不进地图数据
    const names = new Map<string, string>(
      GEO_COUNTRIES.filter((c) => c.n).map((c) => [c.k, c.n] as const)
        .concat(GEO_MINI.map((m) => [m.k, m.n] as const)),
    );
    const countries: WorldCountryDatum[] = [...acc.entries()].flatMap(([iso, v]) => {
      const name = names.get(iso);
      if (!name) return [];
      return [{
        iso, name,
        rank: 0, // 降序排完后统一回填
        players: v.players,
        power: v.power,
        bestName: v.best.name,
        bestRank: v.best.rank,
        bestSum: v.best.sum,
      }];
    });
    if (!countries.length) {
      console.error(`[worldtop] 聚合 0 国（acc=${acc.size}）`);
      return null;
    }
    countries.sort((a, b) => b.power - a.power);
    countries.forEach((c, i) => (c.rank = i + 1));
    console.error(
      `[worldtop] 聚合完成: 全榜 ${total} 人 → ${countries.length} 国（前3: ${countries
        .slice(0, 3)
        .map((c) => `${c.name}${c.players}人`)
        .join("、")}）`,
    );
    return { countries, fetchedAt: Date.now() };
  } catch (e) {
    console.error("[worldtop] fetchWorldCountryStats 异常:", e);
    return null;
  }
}

/** 全量国家统计（1 天缓存；失败返回 null 由组件隐藏地图）
    v2: 修聚合只覆盖 TOP100 的 bug——fetchPage 返回的 total 是「本页末名次」
    （满页恒 100），翻页循环永不执行；改为指数探边定全榜总量后再拉全量
    v3: 探边指数跳会跨过短页踩到空页（fetchPage 对空页返回 null），改为
    越界后二分收缩找末页；v2 曾把探边失败 null 缓存一天，升键强制重建 */
export const getWorldCountryStats = unstable_cache(fetchWorldCountryStats, ["world-country-stats-v6"], {
  revalidate: 86400,
  tags: ["world-country-stats"],
});
