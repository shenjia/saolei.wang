// 雷界生态（移植 2008 版 World/World.asp + World/Hero.asp）
// 左：各军衔人数分布（Bar 图）；右：神界全员（大元帅/元帅/大将 = 编制前 41 人）

import Link from "next/link";
import { getHeroList, getTitleCounts } from "@/lib/queries";
import { TITLE_CLASSES } from "@/lib/config";
import { scoreTime } from "@/lib/format";
import { AvatarCell, TitleBadge } from "@/components/Cells";

export const dynamic = "force-dynamic";
export const metadata = { title: "雷界 | 扫雷网" };

export default async function WorldPage() {
  const [counts, heroes] = await Promise.all([getTitleCounts(), getHeroList(41)]);
  const max = Math.max(1, ...counts.map((c) => c.count));

  return (
    <div id="page" className="two_columns">
      <ul id="home">
        <li className="main">
          <div className="box">
            <h1>雷界军衔分布</h1>
            <table cellPadding={0} cellSpacing={0} className="table full">
              <tbody>
                {counts.map((c) => (
                  <tr key={c.title}>
                    <td style={{ width: 80 }}>
                      <em className={TITLE_CLASSES[c.title] ?? ""}>{c.title}</em>
                    </td>
                    <td>
                      <span
                        className="bar"
                        style={{
                          display: "inline-block",
                          height: 12,
                          width: `${Math.max(2, Math.round((c.count / max) * 100))}%`,
                          background: "#668cba",
                          verticalAlign: "middle",
                        }}
                      ></span>{" "}
                      <em>{c.count}</em> 人
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </li>
        <li className="sidebar">
          <div className="box">
            <Link href="/hero" target="_blank">
              <h2>神界全员（大将及以上）</h2>
            </Link>
            <table cellPadding={0} cellSpacing={0} className="table full">
              <tbody>
                {heroes.map((u, i) => (
                  <tr key={u.id}>
                    <td className="rank">
                      <em>{i + 1}</em>
                    </td>
                    <td className="user">
                      <AvatarCell id={u.id} name={u.chineseName} sex={u.sex} gender="small" link />
                    </td>
                    <td>
                      <TitleBadge title={u.title} link />
                    </td>
                    <td className="time">{scoreTime(u.sumTime)}</td>
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
