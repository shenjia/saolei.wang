// 基础展示组件，移植自 2013 版 PHP 的 views/user/_avatarCell、views/common/title、score_*

import Link from "next/link";
import { INVALID_3BVS_TIP, TITLE_CLASSES, titleConditionText } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite, TIME_NEVER } from "@/lib/format";
import { RankBadge } from "./RankBadge";

/** 用户名 + 性别图标（移植 _avatarCell） */
export function AvatarCell({
  id,
  name,
  sex,
  link = false,
  className = "",
  gender = "",
}: {
  id: number;
  name: string;
  sex: number;
  link?: boolean;
  className?: string;
  gender?: string;
}) {
  return (
    <>
      {link ? (
        <Link href={`/user/${id}`} className={`avatar_link ${className}`} target="_blank">
          {name}
        </Link>
      ) : (
        <span className={`avatar_link ${className}`}>{name}</span>
      )}
      <span className={`gender ${sex ? "male" : "female"} ${gender}`}></span>
    </>
  );
}

/** 军衔徽章（移植 common/title；2026-09-23 起文字前加徽章图标，badgeSize 可放大）
 *  2026-10-13 起 hover 弹条件气泡（高级记录 < xx秒，与军衔体系页文案一致） */
export function TitleBadge({
  title,
  link = false,
  badgeSize,
}: {
  title: string;
  link?: boolean;
  badgeSize?: number;
}) {
  if (!title) return <span className="title"></span>;
  const cls = TITLE_CLASSES[title] ?? "";
  const tip = titleConditionText(title);
  const inner = (
    <>
      <RankBadge title={title} size={badgeSize} />
      <em className={cls}>{title}</em>
    </>
  );
  return link ? (
    <Link href="/page/titles" className="title" target="_blank" data-tip={tip || undefined}>
      {inner}
    </Link>
  ) : (
    <span className="title" data-tip={tip || undefined}>
      {inner}
    </span>
  );
}

/** 时间成绩（移植 common/score_time） */
export function ScoreTime({
  score,
  videoId,
  date,
  noflag = false,
  className = "",
}: {
  score: number | null;
  videoId?: number | null;
  date?: number | null;
  noflag?: boolean;
  className?: string;
}) {
  return (
    <span className={`score_time ${className}`}>
      {score && score > 0 ? (
        <>
          {videoId ? (
            <Link href={`/video/${videoId}`} target="_blank">
              <em>{scoreTime(score)}</em>
            </Link>
          ) : (
            <em>{scoreTime(score)}</em>
          )}
          秒
        </>
      ) : (
        <ins className="null" title="在此级别没有被承认成绩的录像，因此没有记录">
          ?
        </ins>
      )}
      {noflag && <ins title="仅用左键点击完成游戏，全程不用右键标雷">NF</ins>}
      {/* 2026-10-13 张老师要求：日期包 .score_date，用户主页窄屏（≤768）整体隐藏 */}
      {date ? <span className="score_date">({timeOpposite(date, TIME_NEVER)})</span> : null}
    </span>
  );
}

/** 3BV/s 成绩（移植 common/score_3bvs） */
export function Score3bvs({
  score,
  videoId,
  date,
  className = "",
}: {
  score: number | null;
  videoId?: number | null;
  date?: number | null;
  className?: string;
}) {
  return (
    <span className={`score_3bvs ${className}`}>
      3BV/s
      {score && score > 0 ? (
        videoId ? (
          <Link href={`/video/${videoId}`} target="_blank">
            <em>{score3bvs(score)}</em>
          </Link>
        ) : (
          <em>{score3bvs(score)}</em>
        )
      ) : score && score < 0 ? (
        // 无效成绩 hover 弹自定义气泡（2026-10-13 张老师要求，同录像详情页）
        <del data-tip={INVALID_3BVS_TIP} aria-label={INVALID_3BVS_TIP}>
          {score3bvs(-score)}
        </del>
      ) : (
        <ins className="null" title="在此级别没有被承认成绩的录像，因此没有记录">
          ?
        </ins>
      )}
      {date ? <span className="score_date">({timeOpposite(date, TIME_NEVER)})</span> : null}
    </span>
  );
}
