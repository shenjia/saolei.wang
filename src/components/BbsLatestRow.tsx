// 首页论坛新帖单行（客户端，2026-11-14）：已读口径与论坛列表页完全一致——
// 点过（点击时刻记录 lastReplyTime 快照）且读后无新回复 → 标题暗灰 #75715e；
// 点过但其后来了新回复（lastReplyTime 超快照）→ 恢复亮灰 #bbbbbb（视同未读）。
// 公告/精华已读保持亮灰（isBbsKeep，同 BbsFeed 口径）。
// 取数在服务端 BbsLatestFeed（BbsLatest.tsx），本组件只收序列化安全的标量字段

"use client";

import Link from "next/link";
import { isBbsRead, isBbsKeep, markBbsRead, useBbsReadMap } from "./BbsRead";

export function BbsLatestRow({
  id,
  board,
  boardName,
  title,
  isNice,
  lastReplyTime,
}: {
  id: number;
  board: number;
  /** 板块名（服务端按 board 解析传入，客户端不引 BBS_BOARD_NAMES） */
  boardName: string;
  title: string;
  isNice: boolean;
  lastReplyTime: number;
}) {
  const readMap = useBbsReadMap();
  const isRead = isBbsRead(readMap, id, lastReplyTime);
  return (
    <tr className={isRead ? "read" : undefined}>
      <td className="subject">
        <div className="wrap">
          <span
            className={
              "board_tag" +
              (board === 0 ? " notice" : board === 1 ? " tech" : board === 3 ? " qa" : "")
            }
          >
            {boardName}
          </span>
          {/* 2026-10-23（张老师）：取消论坛高亮——首页新帖标题不再加 .high 白显 */}
          {/* 2026-10-24（张老师）：置顶/精华尾部标记（▲/.精）不再渲染，空间全留给标题 */}
          <Link
            href={`/bbs/${id}`}
            target="_blank"
            prefetch={false}
            className={"t" + (isRead && isBbsKeep({ board, isNice }) ? " keep" : "")}
            onClick={() => markBbsRead(id, lastReplyTime)}
          >
            {title}
          </Link>
        </div>
      </td>
    </tr>
  );
}
