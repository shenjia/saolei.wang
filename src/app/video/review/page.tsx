// 录像审核列表（移植 VideoController::actionReview 的列表分支 + views/video/reviewList）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getReviewList } from "@/lib/queries";
import { isManager, VIDEO_STATUS } from "@/lib/config";
import { Pager, Tabs } from "@/components/Pager";
import { ReviewList } from "@/components/ReviewList";

export const dynamic = "force-dynamic";
export const metadata = { title: "录像审核 | 扫雷网" };

const STATUSES = [VIDEO_STATUS.NORMAL, VIDEO_STATUS.REVIEWED, VIDEO_STATUS.BANNED] as number[];

export default async function VideoReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");
  if (!isManager(session.role)) redirect("/video");

  const sp = await searchParams;
  const status = STATUSES.includes(parseInt(sp.status ?? "", 10))
    ? parseInt(sp.status ?? "", 10)
    : VIDEO_STATUS.NORMAL;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const { videos, total, pageSize } = await getReviewList(status, page);

  return (
    <div id="page" className="two_columns">
      <div id="video_list_header" className="box">
        <h1>审核</h1>
        <div className="filters">
          <Tabs
            base="/video/review"
            params={{ status }}
            name="status"
            current={String(status)}
            options={[
              [String(VIDEO_STATUS.NORMAL), "待审核"],
              [String(VIDEO_STATUS.REVIEWED), "已通过"],
              [String(VIDEO_STATUS.BANNED), "已屏蔽"],
            ]}
          />
        </div>
      </div>
      <ReviewList key={`${status}_${page}`} initial={videos} />
      <Pager base="/video/review" params={{ status }} page={page} total={total} pageSize={pageSize} />
    </div>
  );
}
