// 军衔页 /titles（原 /world 雷界生态，2026-09-24 张老师要求改名——页面定位已是军衔体系，world 名不副实）
// 2026-09-23 合并军衔体系页（张老师要求）：
//   上：18+1 级徽章墙（按阶段分组并排，徽章 + 军衔名 + 共 X 人）
//   右栏：旧版称号（2008～2013）对比
//   （神界全员、雷界军衔分布 Bar 图两个板块同日按张老师要求移除）
// 2026-09-24 张老师要求：顶部统计数字标签移除，页面定位回归「军衔」；
//   徽章卡片可点击进入 /titles/[军衔名] 查看本军衔所有玩家（每页 20 条懒加载）；
//   元帅人数数字金色（与军衔文字同色 #e6db74）
// /page/titles（全站 TitleBadge 链接）302 跳转到本页

import Link from "next/link";
import { getTitleCounts } from "@/lib/queries";
import { OLD_TITLES, TITLE_COLORS } from "@/lib/config";
import { RankBadge } from "@/components/RankBadge";

export const dynamic = "force-dynamic";
export const metadata = { title: "军衔 | 扫雷网" };

// 按阶段分组（同阶段并排显示）
const TITLE_TIERS: string[][] = [
  ["大元帅", "元帅"],
  ["大将", "上将", "中将", "少将"],
  ["大校", "上校", "中校", "少校"],
  ["上尉", "中尉", "少尉"],
  ["上士", "中士", "下士"],
  ["上等兵", "列兵"],
  ["预备役"],
];

export default async function TitlesPage() {
  const counts = await getTitleCounts();
  const countMap = new Map(counts.map((c) => [c.title, c.count]));

  return (
    <div id="page" className="two_columns">
      <ul id="home">
        <li className="main">
          <div className="box">
            <h1>
              军衔体系 <span className="era">（2026～至今）</span>
            </h1>
            <div className="titles_grid">
              {TITLE_TIERS.map((tier) => (
                <div className="tier_row" key={tier[0]}>
                  {tier.map((t) => (
                    <Link href={`/titles/${encodeURIComponent(t)}`} className="title_card" key={t} title={`查看${t}玩家`}>
                      <RankBadge title={t} size={46} />
                      <div className="name" style={{ color: TITLE_COLORS[t] }}>
                        {t}
                      </div>
                      <div className="meta">
                        共 <em style={t === "元帅" ? { color: "#e6db74" } : undefined}>{countMap.get(t) ?? 0}</em> 人
                      </div>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </li>
        <li className="sidebar">
          <div className="box">
            <h2>
              旧版称号 <span className="era">（2008～2013）</span>
            </h2>
            <table cellPadding={0} cellSpacing={0} className="table full" style={{ fontFamily: "宋体" }}>
              <tbody>
                {OLD_TITLES.map((t) => (
                  <tr key={t.name}>
                    <td
                      className="tac"
                      style={{
                        color: t.color,
                        fontWeight: "bold",
                        whiteSpace: "nowrap",
                        padding: "3px 10px",
                        fontSize: 12,
                        fontFamily: "宋体",
                      }}
                    >
                      {t.name}
                    </td>
                    <td
                      className="tal"
                      style={{
                        whiteSpace: "nowrap",
                        padding: "3px 10px",
                        fontSize: 12,
                        fontFamily: "宋体",
                        color: "#BBBBBB",
                      }}
                    >
                      {t.condition}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </li>
      </ul>
    </div>
  );
}
