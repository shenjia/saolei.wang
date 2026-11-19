// 「今日已收集 x BV / 创造 y PB　活跃+z」行内段（2026-11-08 张老师统一版式）：
// 首页 PracticeToday 的 pt_ranked 行与练习页 OnlinePlay 的 op_ranked 行共用，
// 版式一次定稿两处同步。颜色类（bv/zero/pbv/actv）不带样式——由各页自己的
// 选择器（.practice_today .pt_ranked / #online_play .op_ranked）按各自的
// 字号灰阶口径着色。数值直接渲染（SSR 初值即真值）；练习页传 id* 挂点供
// paintRanked 命令式直写（局终/上传成功实时自增，同 op_today 口径）。
export function RankedTodayLine({
  beg,
  int,
  exp,
  pb,
  act,
  idBv,
  idPb,
  idAct,
}: {
  /** 初/中/高级今日新收集 BV 数（渲染为三者合计单值） */
  beg: number;
  int: number;
  exp: number;
  /** 今日创造 PB 次数（打破本BV最好成绩，与列表黄点 pb_bv 同源） */
  pb: number;
  /** 今日活跃值（活跃榜 active_points 同口径的当日值：练习点+登录 1+观看+录像+评论，
   *  2026-11-11 张老师定：恒 ≥1 不可能加 0） */
  act: number;
  /** 练习页命令式直写挂点 id（首页不传） */
  idBv?: string;
  idPb?: string;
  idAct?: string;
}) {
  const bv = beg + int + exp;
  return (
    <>
      <span className="lead">今日已收集</span>
      <b className={`bv${bv > 0 ? "" : " zero"}`} id={idBv}>
        {bv}
      </b>
      <span className="lead">BV</span>
      <span className="sep">/</span>
      <span className="pbpart">
        创造 <b className={`pbv${pb > 0 ? "" : " zero"}`} id={idPb}>{pb}</b> PB
      </span>
      <span className="actpart">
        活跃<b className={`actv${act > 0 ? "" : " zero"}`} id={idAct}>+{act}</b>
      </span>
    </>
  );
}
