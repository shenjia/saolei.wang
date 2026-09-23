// 每日一星详情卡（移植 2008 版 Player/Star.asp：照片 + 各级纪录 + 按钮）
// 称号用旧版称号（2026-09-23 张老师要求）；人界/神界叫法已取消，直接显示「第 N 位」

import Link from "next/link";
import { getTodayStar } from "@/lib/star";
import { getFirstRankedUserId, getUserDetail, getUserSumRank } from "@/lib/queries";
import { oldTitle } from "@/lib/oldtitle";
import { score3bvs, scoreTime, formatDate } from "@/lib/format";
import { LEVEL_NAMES, type Level } from "@/lib/config";
import { StarPhoto } from "./StarPhoto";

function StarScore({
  score,
  videoId,
  isTime,
  highlight = false,
}: {
  score: number | null;
  videoId: number | null;
  isTime: boolean;
  highlight?: boolean;
}) {
  if (!score || score <= 0) return <>-</>;
  const text = isTime ? scoreTime(score) : score3bvs(score);
  const inner = highlight ? <em className="hl">{text}</em> : <em>{text}</em>;
  return videoId ? (
    <Link href={`/video/${videoId}`} target="_blank" title="点击查看录像">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export async function DailyStarCard({ delta }: { delta?: number | null }) {
  const star = await getTodayStar();
  if (!star?.user) return null;
  const [detail, rank, firstId] = await Promise.all([
    getUserDetail(star.user.id),
    getUserSumRank(star.user.id),
    getFirstRankedUserId(),
  ]);
  if (!detail) return null;
  const u = detail.user;
  const t = oldTitle(detail.scores.exp_time?.score ?? 0, u.sex, u.id === firstId);

  return (
    <div id="daily_star_card" className="box">
      <table cellPadding={0} cellSpacing={0}>
        <tbody>
          <tr>
            <td className="photo_col">
              <StarPhoto id={u.id} name={u.chineseName} hasPhoto={u.avatar === "1"} />
              <Link href={`/user/${u.id}`} target="_blank" className="star_btn">
                访问我的地盘
              </Link>
              <Link href={`/message?to=${u.id}`} target="_blank" className="star_btn">
                给我发短消息
              </Link>
            </td>
            <td className="info_col">
              <div className="head">
                <Link href={`/user/${u.id}`} target="_blank" className="name">
                  {u.chineseName}
                </Link>
                &nbsp;(Id:&nbsp;{u.id})&nbsp;
                <Link href="/world" target="_blank" title="点击查看称号说明" className="oldtitle">
                  <span style={{ color: t.color }}>{t.name}</span>
                </Link>
                <span className="sex">{u.sex ? "GG" : "mm"}</span>
              </div>
              {rank > 0 && (
                <div className="rank_line">
                  第&nbsp;<em className="hl">{rank}</em>&nbsp;位&nbsp;
                  {delta === null || delta === undefined ? (
                    <span className="up" title="昨日新上榜">↑新</span>
                  ) : delta === 0 ? (
                    <span className="flat" title="与昨日持平">→</span>
                  ) : delta > 0 ? (
                    <span className="up" title={`比昨日进步${delta}位`}>↑{delta}</span>
                  ) : (
                    <span className="down" title={`比昨日下降${-delta}位`}>↓{-delta}</span>
                  )}
                </div>
              )}
              {(["beg", "int", "exp"] as Level[]).map((lv) => (
                <div key={lv} className="score_line">
                  {LEVEL_NAMES[lv]}纪录：
                  <StarScore score={detail.scores[`${lv}_time`]?.score ?? null} videoId={detail.scores[`${lv}_time`]?.videoId ?? null} isTime />
                  &nbsp;|&nbsp;
                  <StarScore score={detail.scores[`${lv}_3bvs`]?.score ?? null} videoId={detail.scores[`${lv}_3bvs`]?.videoId ?? null} isTime={false} />
                </div>
              ))}
              <div className="score_line sum">
                总计纪录：
                <StarScore score={detail.scores.sum_time?.score ?? null} videoId={null} isTime highlight />
                &nbsp;|&nbsp;
                <StarScore score={detail.scores.sum_3bvs?.score ?? null} videoId={null} isTime={false} highlight />
              </div>
              {detail.stat?.loginTime ? (
                <div className="login_line">最近登录：{formatDate(detail.stat.loginTime, "Y年n月j日")}</div>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
