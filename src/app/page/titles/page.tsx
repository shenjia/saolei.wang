// 军衔体系说明页（移植 views/site/pages/titles）
// 点击任意军衔徽章（TitleBadge link）跳转到此页

import { getTitleDistribution } from "@/lib/assess";
import { TitleBadge } from "@/components/Cells";
import { FIXED_TITLES, TITLES, TITLE_DISTRIBUTION } from "@/lib/config";
import { formatDate, scoreTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/** 编制人数（移植 titles.php 的分支逻辑；intval 对正数等同 Math.floor） */
function headcount(index: number, total: number): number {
  const title = TITLES[index];
  const pre = TITLES[index - 1];
  // 第一个固定军衔：直接返回编制数
  if (index === 0) return TITLE_DISTRIBUTION[title];
  // 其余固定军衔：与上一级的差值
  if ((FIXED_TITLES as readonly string[]).includes(title)) {
    return TITLE_DISTRIBUTION[title] - TITLE_DISTRIBUTION[pre];
  }
  // 第一个比例军衔：直接按比例
  if (index === FIXED_TITLES.length) {
    return Math.floor(TITLE_DISTRIBUTION[title] * total);
  }
  // 最后一个比例军衔：与总人数的差值
  if (index === TITLES.length - 1) {
    return total - Math.floor(TITLE_DISTRIBUTION[pre] * total);
  }
  // 普通比例军衔：与上一级的差值
  return Math.floor(TITLE_DISTRIBUTION[title] * total) - Math.floor(TITLE_DISTRIBUTION[pre] * total);
}

export default async function TitlesPage() {
  const dist = await getTitleDistribution();
  const thresholds = dist?.thresholds ?? [];
  const total = dist?.size ?? 0;
  const publishDate = dist?.createTime ? formatDate(dist.createTime, "Y年n月j日") : "";

  return (
    <div id="page" className="main">
      <div id="titles_page" className="text box">
        <h1>军衔体系</h1>
        <h2>({publishDate}颁布)</h2>
        <table cellPadding={0} cellSpacing={0} className="table">
          <thead>
            <tr>
              <td>级别</td>
              <td>军衔</td>
              <td className="tal">要求</td>
              <td>编制</td>
              <td></td>
            </tr>
          </thead>
          <tbody>
            {TITLES.map((t, i) => (
              <tr key={t}>
                <td className="tac">{TITLES.length - i}</td>
                <td>
                  <TitleBadge title={t} />
                </td>
                <td>
                  SUM <em>{scoreTime(thresholds[i])}</em> 秒
                </td>
                <td>
                  <em>{headcount(i, total)}</em>人
                </td>
                <td>{/* 登录后在此标注「我的军衔」（暂未实现账号体系） */}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <hr />
        <h2>说明</h2>
        <p>
          1、以上军衔的要求计算的是玩家的<em>总时间成绩</em>。
        </p>
        <p>2、当你的成绩达到相应的要求，系统将自动为你颁发相应的军衔。</p>
        <p>
          3、以上军衔制度共计编制<em>{total}</em>人。
          由于扫雷玩家在不断增多，大家的水平也在不断进步，新制度发布后一段时间，部分军衔的持有人数就会超过编制。所以系统会定期对编制进行调整以恢复平衡，届时部分玩家的军衔会发生起伏。
        </p>
      </div>
    </div>
  );
}
