// 用户主页：成绩总表 + 最新动态 + 个人资料（移植 views/user/view）

import { notFound } from "next/navigation";
import { getUserDetail, getUserNews } from "@/lib/queries";
import { LEVELS, LEVEL_NAMES, ORDERS, type Level, type Order } from "@/lib/config";
import { NewsCell } from "@/components/NewsCell";
import { Score3bvs, ScoreTime, TitleBadge } from "@/components/Cells";

export const dynamic = "force-dynamic";

const PROFILE_FIELDS: [string, string][] = [
  ["nickname", "昵称"],
  ["selfIntro", "自我介绍"],
  ["interest", "兴趣爱好"],
  ["qq", "QQ"],
  ["mouse", "鼠标"],
  ["pad", "鼠标垫"],
];

export default async function UserViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = parseInt(id, 10);
  if (!userId) notFound();

  const detail = await getUserDetail(userId);
  if (!detail) notFound();
  const news = await getUserNews(userId, 10);

  const { user, info, scores } = detail;

  return (
    <ul id="user_view">
      <li className="main">
        <div className="info box">
          <h1>{user.chineseName}</h1>
          <h2>({user.englishName})</h2>
          <span className={`gender big ${user.sex ? "male" : "female"}`}></span>
          <TitleBadge title={detail.title} link />
          <table className="scores" cellPadding={0} cellSpacing={0}>
            <tbody>
              {LEVELS.map((level: Level) => {
                const timeRec = scores[`${level}_time`];
                const bvsRec = scores[`${level}_3bvs`];
                return (
                  <tr key={level}>
                    <th>{LEVEL_NAMES[level]}</th>
                    <td>
                      <ScoreTime
                        score={timeRec?.score ?? null}
                        videoId={timeRec?.videoId ?? null}
                        date={timeRec?.date ?? null}
                        className={level}
                      />
                    </td>
                    <td>
                      <Score3bvs
                        score={bvsRec?.score ?? null}
                        videoId={bvsRec?.videoId ?? null}
                        date={bvsRec?.date ?? null}
                        className={level}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {news.length > 0 && (
          <div id="news" className="box">
            <h2>最新动态</h2>
            <table cellPadding={0} cellSpacing={0} className="table">
              <tbody>
                {news.map((item) => (
                  <NewsCell key={item.id} news={item} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="profile box">
          <h2>个人资料</h2>
          <span className="id">
            ID.<em>{user.id}</em>
          </span>
          <hr />
          <table className="form">
            <tbody>
              {PROFILE_FIELDS.map(([key, label]) => {
                const value = info?.[key as keyof NonNullable<typeof info>];
                if (!value) return null;
                return (
                  <tr key={key}>
                    <th>{label}</th>
                    <td>{value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </li>
      <li className="sidebar">
        {detail.stat && (
          <div className="box">
            <h2>统计</h2>
            <table className="table full">
              <tbody>
                <tr>
                  <td>登录次数</td>
                  <td>{detail.stat.loginTimes}</td>
                </tr>
                <tr>
                  <td>积分</td>
                  <td>{detail.stat.points}</td>
                </tr>
                <tr>
                  <td>初级录像</td>
                  <td>{detail.stat.begVideos}</td>
                </tr>
                <tr>
                  <td>中级录像</td>
                  <td>{detail.stat.intVideos}</td>
                </tr>
                <tr>
                  <td>高级录像</td>
                  <td>{detail.stat.expVideos}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </li>
    </ul>
  );
}
