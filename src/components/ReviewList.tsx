// 审核列表（移植 views/video/reviewList）：每行 = 录像单元格（新标签页打开详情）+ 通过/屏蔽按钮
// 操作成功后把该行从列表移除（对应旧版 remove_from_list 的 hide 行为）

"use client";

import Link from "next/link";
import { useState } from "react";
import type { VideoListItem } from "@/lib/queries";
import { ReviewButtons } from "./ReviewButtons";
import { VideoDetailCell } from "./VideoCell";

export function ReviewList({ initial }: { initial: VideoListItem[] }) {
  const [items, setItems] = useState(initial);

  return (
    <div id="video_list" className="ranking_list mode_detail">
      {items.map((v) => (
        <div key={v.id} className="review_row">
          <Link href={`/video/${v.id}`} target="_blank">
            <VideoDetailCell video={v} />
          </Link>
          <div className="review_actions">
            <ReviewButtons
              videoId={v.id}
              status={v.status}
              onDone={() => setItems((prev) => prev.filter((i) => i.id !== v.id))}
            />
          </div>
        </div>
      ))}
      {items.length === 0 && <div className="box">没有该状态的录像</div>}
    </div>
  );
}
