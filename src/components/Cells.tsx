// 基础展示组件，移植自 2013 版 PHP 的 views/user/_avatarCell、views/common/title、score_*

import Link from "next/link";
import { INVALID_3BVS_TIP } from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite, TIME_NEVER } from "@/lib/format";

// TitleBadge 已拆分至独立客户端组件（2026-10-17 双体系渲染），此处 re-export 保持 26 处引用不变
export { TitleBadge } from "./TitleBadge";

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
        // 2026-10-22 张老师要求：「?」用 em 包住，与成绩数字同位同字体（位置天然对齐），仅灰色
        <em className="null" title="在此级别没有被承认成绩的录像，因此没有纪录">
          ?
        </em>
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
        // 2026-10-22 张老师要求：「?」用 em 包住，与成绩数字同位同字体（位置天然对齐），仅灰色
        <em className="null" title="在此级别没有被承认成绩的录像，因此没有纪录">
          ?
        </em>
      )}
      {date ? <span className="score_date">({timeOpposite(date, TIME_NEVER)})</span> : null}
    </span>
  );
}
