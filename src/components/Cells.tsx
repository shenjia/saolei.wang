// 基础展示组件，移植自 2013 版 PHP 的 views/user/_avatarCell、views/common/title、score_*

import Link from "next/link";
import { INVALID_3BVS_TIP } from "@/lib/config";
import { resolveAvatarUrl } from "@/lib/avatar";
import { score3bvs, scoreTime, timeOpposite, TIME_NEVER } from "@/lib/format";

// TitleBadge 已拆分至独立客户端组件（2026-10-17 双体系渲染），此处 re-export 保持 26 处引用不变
export { TitleBadge } from "./TitleBadge";

/** 玩家名 hover 气泡内容（2026-10-29 张老师要求二轮：文案改「#ID 姓名 英文名」，
 *  姓名亮灰、ID 与英文名暗灰——CSS attr() 无法分段着色，改为内嵌 i 元素结构
 *  （.pt_id/.pt_name/.pt_en），由 .pt_bubble 提供气泡壳。无英文名只显示「#ID 姓名」） */
export function PlayerTip({
  id,
  name,
  englishName,
}: {
  id: number;
  name: string;
  englishName?: string;
}) {
  const en = englishName?.trim();
  // 用 <span> 而非 <i>（2026-10-29 张老师要求：不要斜体字——<i> 浏览器默认 italic）
  return (
    <>
      <span className="pt_id">#{id}</span> <span className="pt_name">{name}</span>
      {en ? (
        <>
          {" "}
          <span className="pt_en">{en}</span>
        </>
      ) : null}
    </>
  );
}

/** 用户名 + 性别图标（移植 _avatarCell）
 *  2026-10-29：link 态挂玩家名气泡（#ID 姓名 英文名，双色富文本） */
export function AvatarCell({
  id,
  name,
  englishName,
  sex,
  link = false,
  className = "",
  gender = "",
}: {
  id: number;
  name: string;
  /** 英文名（气泡用）；缺省/空串时气泡只显示「#ID 姓名」 */
  englishName?: string;
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
          <span className="pt_bubble">
            <PlayerTip id={id} name={name} englishName={englishName} />
          </span>
        </Link>
      ) : (
        <span className={`avatar_link ${className}`}>{name}</span>
      )}
      <span className={`gender ${sex ? "male" : "female"} ${gender}`}></span>
    </>
  );
}

/** 主题详情作者名：头像与名字共同排版；无头像时不渲染图片、不增加占位。 */
export function BbsAuthorName({
  id,
  name,
  englishName,
  sex,
  avatar = "",
}: {
  id: number;
  name: string;
  englishName?: string;
  sex: number;
  avatar?: string;
}) {
  const avatarUrl = resolveAvatarUrl(avatar, avatar === "1" ? `/images/player/${id}.jpg` : "");
  if (!avatarUrl)
    return <AvatarCell id={id} name={name} englishName={englishName} sex={sex} gender="small" link />;
  return (
    <span className="bbs_meta_author">
      <img className="bbs_meta_avatar" src={avatarUrl} alt="" width={16} height={16} />
      <AvatarCell id={id} name={name} englishName={englishName} sex={sex} gender="small" link />
    </span>
  );
}

/** 排行榜姓名：上传头像绝对定位在左侧预留区，不参与名字与性别图标的居中排版。 */
export function RankingName({
  id,
  name,
  englishName,
  sex,
  avatar = "",
}: {
  id: number;
  name: string;
  englishName?: string;
  sex: number;
  avatar?: string;
}) {
  // 与主页/用户卡片同口径：新版上传、OAuth 外链、旧站 "1"（照片墙实体）；
  // 无头像时 fallback 为空，绝不把默认 no.jpg 混进排行榜。
  const avatarUrl = resolveAvatarUrl(avatar, avatar === "1" ? `/images/player/${id}.jpg` : "");
  return (
    <>
      <span className="ranking_name">
        {avatarUrl && <img className="ranking_avatar" src={avatarUrl} alt="" width={13} height={13} />}
        <Link href={`/user/${id}`} target="_blank" prefetch={false}>
          {name}
          <span className="pt_bubble">
            <PlayerTip id={id} name={name} englishName={englishName} />
          </span>
        </Link>
      </span>
      <span className={`gender ${sex ? "male" : "female"} small`}></span>
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
  allowZero = false,
}: {
  score: number | null;
  videoId?: number | null;
  date?: number | null;
  className?: string;
  /** 初级有成绩但 3BV 未达限界时，0 是有效零纪录；其他无成绩场景仍显示「?」 */
  allowZero?: boolean;
}) {
  return (
    <span className={`score_3bvs ${className}`}>
      3BV/s
      {score !== null && (score > 0 || (allowZero && score === 0)) ? (
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
