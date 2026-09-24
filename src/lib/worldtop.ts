// 世界 TOP100：抓取 minesweepergame.com 世界排行（2026-09-23 张老师提供接口；当晚要求从 TOP10 扩到 TOP100）
// 缓存 1 天（unstable_cache revalidate=86400），降低抓取频率；
// 接口对裸 curl 返回 403，必须带浏览器 UA + Referer；start=0 单页即返回 1-100 名。

import { unstable_cache } from "next/cache";

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
