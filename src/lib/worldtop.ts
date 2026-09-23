// 世界 TOP100：抓取 minesweepergame.com 世界排行（2026-09-23 张老师提供接口；当晚要求从 TOP10 扩到 TOP100）
// 缓存 1 天（unstable_cache revalidate=86400），降低抓取频率；
// 接口对裸 curl 返回 403，必须带浏览器 UA + Referer；start=0 单页即返回 1-100 名。

import { unstable_cache } from "next/cache";

const URL = "https://minesweepergame.com/common/ajax/ajax-ranking-world.php?rid=1&start=0&sort=0";
export const WORLD_RANKING_PAGE = "https://minesweepergame.com/world-rankings.php";
export const WORLD_TOP_LIMIT = 100;

export interface WorldRow {
  rank: number;
  flag: string; // 国旗代码（china/poland/...），中国行高亮
  name: string;
  beg: string;
  int: string;
  exp: string;
  sum: string;
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
    // 三级成绩各在一个 text-align:right 单元格：新成绩是 <a> 链接，老成绩可能是纯文本（无录像文件）
    const cells = [...rest.matchAll(/<td style='text-align:right;'>([\s\S]*?)<\/td>/g)].map((x) =>
      stripTags(x[1])
    );
    const sumM = /<td style='text-align:center;'>(\d+(?:\.\d+)?)<\/td>/.exec(rest);
    if (cells.length < 3 || cells.slice(0, 3).some((c) => !/^\d+\.\d+$/.test(c)) || !sumM) continue;
    rows.push({
      rank: parseInt(rank, 10),
      flag,
      name: stripTags(nameHtml),
      beg: cells[0],
      int: cells[1],
      exp: cells[2],
      sum: sumM[1],
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
// 缓存键带版本号：解析逻辑修复（2026-09-23 国旗连字符/纯文本成绩）后需丢弃旧缓存
export const getWorldTop100 = unstable_cache(fetchWorldTop, ["world-top100-v2"], {
  revalidate: 86400,
  tags: ["world-top100"],
});
