// 比赛详情页「动态」板块客户端壳（2026-11-13 五轮 20:31 张老师定：
// 标准翻页组件 = 首页同款 PageSlider「···加载更多 + 滑轨滚动翻页」，非页码式 Pager）。
//
// 语义（与 TourListFeed 同口径）：
// · 滑轨/◀▶ 换页 → router.push(?ep=N&page=对方页码)，URL 即状态、RSC 重渲染；
// · 「···加载更多」→ GET /api/tournament/[id]/events?page=1&size=前缀长度
//   （动态最新在前、新事件会插到头部，前缀整批替换即「加载后最新快照」，无重复无跳行）；
//   hasMore 按「已加载 < total」判；
// · 首屏数据由服务端 RSC 传入（SSR 可见、无 JS 降级仍能看首屏与 URL 换页）。

"use client";

import Link from "next/link";
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { RelTime } from "@/components/RelTime";
import { AvatarCell } from "@/components/Cells";
import { TitleBadge } from "@/components/TitleBadge";
import { DeltaArrow } from "@/components/RankingRows";
import { compEventText, type TourEventRow } from "@/lib/tournament";
import { fmtTourScore, type TourMetricKey } from "@/lib/tour-metric";
import { TourCalcTip } from "@/components/tournament/TourCalcTip";
import { replaceWithoutJump } from "@/components/useNoJump";

export function TourEventsFeed({
  compId,
  initialRows,
  initialPage,
  initialTotal,
  initialTotalPages,
  /** 录像板块当前页码（URL ?page=，换动态页时带上不丢对方状态） */
  videosPage,
  pageSize,
  /** 计分数据项与方向（2026-11-21 多数据项：成绩格式化 + 提升箭头方向） */
  scoreMetric,
  scoreDesc,
}: {
  compId: number;
  initialRows: TourEventRow[];
  initialPage: number;
  initialTotal: number;
  initialTotalPages: number;
  videosPage: number;
  pageSize: number;
  scoreMetric: TourMetricKey;
  scoreDesc: boolean;
}) {
  const router = useRouter();
  const listRef = useRef<HTMLUListElement>(null);
  const [rows, setRows] = useState<TourEventRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasMore = rows.length < total;

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const size = rows.length + nextBatchSize(step, pageSize);
      const res = await fetch(`/api/tournament/${compId}/events?page=1&size=${size}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        // 视口零跳动（useNoJump 权威方案）：前缀整批替换会改变列表高度，锚定列表顶
        replaceWithoutJump(listRef.current, () => {
          setRows(data.rows);
          setTotal(data.total);
          setTotalPages(data.totalPages);
          setStep((s) => s + 1);
        });
      }
    } finally {
      setLoading(false);
    }
  }

  function gotoPage(p: number) {
    startTransition(() => {
      // 保持滚动位置（张老师 2026-11-19 凌晨定「原地不动」）：
      // scroll:false 拦 Next 滚顶 + ScrollReset 已修同页参数变化不滚顶；
      // 不做主动锚定——板块在视口内时原地替换即可（浏览器 scroll anchoring 保持视觉位置）
      router.push(
        `/tournaments/${compId}?page=${videosPage}${p > 1 ? `&ep=${p}` : ""}`,
        { scroll: false }
      );
    });
  }

  return (
    <>
      {rows.length > 0 ? (
        <ul className="comp_events" ref={listRef}>
          {rows.map((e) => (
            <li key={e.id} className="comp_ev_row">
              <span className="comp_ev_main">
                {/* 事件主体玩家（2026-11-18 晚张老师定：人名+性别+军衔同首页动态——
                    AvatarCell gender=small + TitleBadge；全站事件 1/3/5 无主体不渲染；
                    type=6 完赛事件带玩家主体+最终成绩，2026-11-22） */}
                {(e.userName && e.userId) || e.type === 6 ? (
                  <>
                    <AvatarCell
                      id={e.userId ?? 0}
                      name={e.userName ?? ""}
                      englishName={e.englishName}
                      sex={e.sex}
                      gender="small"
                      link
                    />
                    <TitleBadge title={e.title} classic={e.classic} link />
                  </>
                ) : null}
                <span className="comp_ev_text">
                  {/* 官方事件（报名开始/正式开始/正式结束）金色渲染（张老师 2026-11-18 晚定） */}
                  {e.type === 1 || e.type === 3 || e.type === 5 ? (
                    <b className="comp_ev_official">{compEventText(e.type)}</b>
                  ) : e.type === 6 ? (
                    /* 窗口赛完赛事件（2026-11-22 张老师定）：「已完赛」金色（同官方事件）；
                       「最终成绩」标签+成绩数字拆到行右独立列（2026-11-22 气泡改造，
                       见下方 comp_ev_score 注释——原省略号容器会裁掉气泡）；
                       无有效成绩（totalMs=null）标签与数字一并不出（同原口径） */
                    <>
                      <b className="comp_ev_finished">{compEventText(e.type)}</b>
                      {e.totalMs !== null && <span className="comp_ev_finish_label">最终成绩</span>}
                    </>
                  ) : e.type === 4 ? (
                    /* 成绩动态动作文本暗灰（2026-11-22 张老师定）：
                       与亮灰加粗的成绩数值区分层级，只弱化动作、数值仍突出 */
                    <span className="comp_ev_score_action">{compEventText(e.type)}</span>
                  ) : (
                    compEventText(e.type)
                  )}
                  {/* 成绩数字+提升幅度拆到行右独立列（2026-11-22 气泡改造），此处不再渲染 */}
                </span>
              </span>
              {/* 成绩数字独立列（2026-11-22 张老师需求「动态每条成绩数字 hover 出计算过程
                  气泡，同排行榜前10；包括最终成绩数字」）：
                  原先成绩在 comp_ev_main（overflow:hidden 省略号容器）内会被裁掉，
                  拆出来放 flex 兄弟列——顺带根治窄屏下省略号吃掉成绩数字的问题。
                  锚点类 comp_score_tip 复用排行榜既有 CSS 触发组（position:relative +
                  hover 时气泡 display:flex），气泡 absolute 上方弹出、pointer-events:none。
                  · type=4：当时比赛总成绩 + 提升幅度（方向按比赛 metric/desc 解释）；
                  · type=6：个人窗口内最终成绩（完赛快照）。
                  calc=computePlayerScores 产出的各级别明细，无成绩（totalMs=null）不挂。 */}
              {(e.type === 4 || e.type === 6) && e.totalMs !== null ? (
                <span className="comp_ev_score">
                  <b className={"comp_score_tip " + (e.type === 4 ? "comp_ev_total" : "comp_ev_finish_score")}>
                    {fmtTourScore(scoreMetric, e.totalMs)}
                    {e.calc && e.calc.length > 0 && (
                      <TourCalcTip calc={e.calc} metric={scoreMetric} score={e.totalMs} />
                    )}
                  </b>
                  {e.type === 4 && e.prevTotalMs !== null && (
                    <>
                      {scoreDesc ? e.totalMs > e.prevTotalMs : e.totalMs < e.prevTotalMs ? (
                        <span className="delta">
                          <DeltaArrow dir={scoreDesc ? "up" : "down"} />
                          {Math.abs(e.totalMs - e.prevTotalMs) / 1000 <= 0
                            ? "0"
                            : (Math.abs(e.totalMs - e.prevTotalMs) / 1000)
                                .toFixed(3)
                                .replace(/\.?0+$/, "")}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              ) : null}
              <span className="comp_ev_time">
                <RelTime time={e.createTime} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="comp_section_empty">暂无动态</div>
      )}
      <div className="list_footer">
        <PageSlider
          page={initialPage}
          pages={totalPages}
          loading={loading || pending}
          onGoto={gotoPage}
          hasMore={hasMore}
          onMore={loadMore}
        />
      </div>
    </>
  );
}
