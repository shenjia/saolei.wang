// 世界 TOP10：抓取 minesweepergame.com 世界排行（2026-09-23 张老师提供接口）
// 缓存 1 天（unstable_cache revalidate=86400），降低抓取频率；
// 接口对裸 curl 返回 403，必须带浏览器 UA + Referer。

import { unstable_cache } from "next/cache";

const URL = "https://minesweepergame.com/common/ajax/ajax-ranking-world.php?rid=1&start=0&sort=0";
export const WORLD_RANKING_PAGE = "https://minesweepergame.com/world-rankings.php";

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
  const trRe = /<tr><td align='center'>(\d+)<\/td><td><img src='image\/flags\/([a-z_]+)\.gif'>[\s\S]*?<\/td><td>([\s\S]*?)<\/td><td><\/td>([\s\S]*?)(?=<tr>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const [, rank, flag, nameHtml, rest] = m;
    const times = [...rest.matchAll(/>(\d+\.\d+)<\/a>/g)].map((x) => x[1]);
    const sumM = /<td style='text-align:center;'>(\d+(?:\.\d+)?)<\/td>/.exec(rest);
    if (times.length < 3 || !sumM) continue;
    rows.push({
      rank: parseInt(rank, 10),
      flag,
      name: stripTags(nameHtml),
      beg: times[0],
      int: times[1],
      exp: times[2],
      sum: sumM[1],
    });
    if (rows.length >= 10) break;
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

/** 世界 TOP10（1 天缓存；抓取失败返回 null，由组件降级显示） */
export const getWorldTop10 = unstable_cache(fetchWorldTop, ["world-top10"], {
  revalidate: 86400,
  tags: ["world-top10"],
});
