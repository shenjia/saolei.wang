// 首页：雷界动态 + 入伍新兵 + 十大元帅（移植 views/home/index）

import Link from "next/link";
import { getHomeNews, getNewbies, getTopUsers, type NewsItem } from "@/lib/queries";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { NewsCell } from "@/components/NewsCell";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { title as assessTitle } from "@/lib/assess";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [news, newbies, top] = await Promise.all([getHomeNews(), getNewbies(), getTopUsers()]);

  return (
    <ul id="home">
      <li className="main">
        <div id="news" className="box">
          <h1>雷界动态</h1>
          <table cellPadding={0} cellSpacing={0} className="table">
            <tbody>
              {news.map((item) => (
                <NewsCell key={item.id} news={item} />
              ))}
            </tbody>
          </table>
        </div>
      </li>
      <li className="sidebar">
        <div id="newbie" className="box">
          <h2>入伍新兵</h2>
          <table cellPadding={0} cellSpacing={0} className="table full">
            <tbody>
              {newbies.map((n) => (
                <tr key={n.id}>
                  <td className="user">
                    {n.author && (
                      <AvatarCell
                        id={n.author.id}
                        name={n.author.chineseName}
                        sex={n.author.sex}
                        gender="small"
                        link
                      />
                    )}
                    <TitleBadge title={""} />
                  </td>
                  <td className="time">{timeOpposite(n.createTime, TIME_NEVER)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div id="top" className="box">
          <Link href="/ranking" target="_blank">
            <h2>十大元帅</h2>
          </Link>
          <table cellPadding={0} cellSpacing={0} className="table full">
            <tbody>
              {top.map((u, i) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </li>
    </ul>
  );
}
