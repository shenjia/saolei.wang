// 首页管理员审核提醒（2026-11-09 张老师要求）：原「N 部录像待审核 + 去审核」单行升级为双按钮——
// · 一键过（绿字中空钮）：就地批量通过当前「免核定池」（video.batchReview ids=["all"] + pool=exempt，
//   服务端只取 autoFlag=1，闸门保证需核定混不进来）——全是免核定时不必再进后台；
// · 需手审（玫瑰红字中空钮）：直达 /admin/review?status=10&pool=need（需核定池只能逐条手审）。
// 点击一键过 → 按钮禁用、文案「处理中」+ 转圈动画；完成出绿色气泡「已通过xxx个录像」
// （条数取服务端回传 done，防部分失败时虚报），随后 router.refresh 重查 getPoolCounts——
// 还剩手审录像则板块继续显示（总数自动缩为需手审数），没有则整块消失（page.tsx 服务端把关）。
// 桌面 #review_entry 与移动端 #review_entry_top 是同组件两处挂载（CSS 按断点显隐），
// 处理中状态经 window 事件互相同步，避免一个在转另一个还能点。

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { postOp } from "@/components/admin/AdminAction";
import { toast } from "@/components/Toast";
import { VIDEO_STATUS } from "@/lib/config";

/** 任意副本进入处理中 → 广播给全部副本一起禁用 */
const BUSY_EVENT = "review-entry-busy";

export function ReviewEntry({
  mobile = false,
  exempt,
  need,
}: {
  /** true = 移动端主栏副本（#review_entry_top）；false = 桌面侧栏副本（#review_entry） */
  mobile?: boolean;
  /** 免核定（可一键过）数，服务端 getPoolCounts 初值 */
  exempt: number;
  /** 需核定（只能手审）数，服务端 getPoolCounts 初值 */
  need: number;
}) {
  const router = useRouter();
  const [counts, setCounts] = useState({ exempt, need });
  const [busy, setBusy] = useState(false);

  // 服务端重渲（router.refresh → RSC 重跑）带来新初值 → 以服务端权威数为准
  // （覆盖另一副本点完后的更新，也修正部分失败时的本地乐观值）
  useEffect(() => {
    setCounts({ exempt, need });
  }, [exempt, need]);

  // 任一副本开始处理 → 本副本同步禁用
  useEffect(() => {
    const onBusy = () => setBusy(true);
    window.addEventListener(BUSY_EVENT, onBusy);
    return () => window.removeEventListener(BUSY_EVENT, onBusy);
  }, []);

  const total = counts.exempt + counts.need;
  if (total <= 0) return null;

  const approveAll = async () => {
    if (busy || counts.exempt <= 0) return;
    setBusy(true);
    window.dispatchEvent(new CustomEvent(BUSY_EVENT));
    const res = await postOp("video.batchReview", {
      ids: ["all"],
      pool: "exempt",
      status: VIDEO_STATUS.REVIEWED,
    });
    if (res.ok) {
      toast(`已通过${res.done ?? counts.exempt}个录像`, "success", 2400);
      // 本地先收敛（免核定清零，剩手审则按钮只剩玫瑰红），router.refresh 用
      // 服务端权威数校正（部分失败时免核定不清零会自动回显）
      setCounts((c) => ({ ...c, exempt: 0 }));
      router.refresh();
    } else {
      toast(res.error ?? "操作失败", "error");
      setBusy(false);
    }
  };

  return (
    <div id={mobile ? "review_entry_top" : "review_entry"}>
      <span className="n">
        <b>{total}</b> 部录像待审核
      </span>
      {counts.exempt > 0 && (
        <button type="button" className="go go--ok" disabled={busy} onClick={approveAll}>
          {busy && <span className="rv_spin" aria-hidden="true" />}
          {busy ? "处理中" : "一键过"}
        </button>
      )}
      {counts.need > 0 && (
        <Link className="go go--need" href="/admin/review?status=10&pool=need">
          需手审
        </Link>
      )}
    </div>
  );
}
