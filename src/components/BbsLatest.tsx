// 论坛新帖（移植 2008 版首页 BBS/Index_New.asp）：单行列表 + [板块] + 标题
// 2026-09-24 张老师要求：去掉标题前的黄色方块与行尾 M-D 日期（腾出宽度让长标题显示更全）
// 2026-09-26 张老师要求：分类标签与论坛列表页同款徽章渲染（board_tag 四板块配色）
// 2026-10-24 张老师要求：包含置顶帖（置顶在前、新帖补足）；同日再定：
// 置顶/精华尾部标记（▲/.精）一律不加，行内所有空间留给文章标题
// 2026-11-14 张老师要求：已读口径与论坛列表页一致——点过（且读后无新回复）暗灰，
// 点过但来了新回复（lastReplyTime 超点击时刻快照）复亮灰。转客户端壳：
// 服务端 BbsLatestFeed 负责取数（含作者等序列化安全字段），客户端做已读渲染

import Link from "next/link";
import { BbsLatestRow } from "./BbsLatestRow";
import { BBS_BOARD_NAMES, getLatestPosts } from "@/lib/bbs";
import { HOME_BBS_NUMBER } from "@/lib/config";

export async function BbsLatestFeed() {
  const posts = await getLatestPosts(HOME_BBS_NUMBER);
  if (!posts.length) return null;
  return (
    <div id="bbs_latest" className="box">
      <Link href="/bbs" target="_blank" prefetch={false}>
        <h2>论坛新帖</h2>
      </Link>
      <table cellPadding={0} cellSpacing={0} className="bbs_new">
        <tbody>
          {posts.map((p) => (
            <BbsLatestRow
              key={p.id}
              id={p.id}
              board={p.board}
              boardName={BBS_BOARD_NAMES[p.board]}
              title={p.title}
              isNice={p.isNice}
              lastReplyTime={p.lastReplyTime}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
