// 雷神殿（移植 2008 版 Hero/Index.asp：神界前 30 照片墙）

import Link from "next/link";
import { getHeroList } from "@/lib/queries";
import { scoreTime } from "@/lib/format";
import { TitleBadge } from "@/components/Cells";

export const dynamic = "force-dynamic";
export const metadata = { title: "雷神殿 | 扫雷网" };

export default async function HeroPage() {
  const heroes = await getHeroList(30);
  return (
    <div id="page" className="main">
      <div className="box">
        <h1>雷神殿</h1>
        <p className="text">神界前 30 位雷友（按总计时间成绩排列）</p>
        <div id="hero_wall">
          {heroes.map((u, i) => (
            <Link key={u.id} href={`/user/${u.id}`} target="_blank" className="hero_cell">
              <span className="rank">
                No.<em>{i + 1}</em>
              </span>
              <span className="name">{u.chineseName}</span>
              <TitleBadge title={u.title} />
              <span className="score">{scoreTime(u.sumTime)}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
