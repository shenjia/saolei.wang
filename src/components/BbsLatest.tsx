// 论坛新帖（移植 2008 版首页 BBS/Index_New.asp iframe）：首页右栏

import Link from "next/link";
import { BBS_BOARD_NAMES, getLatestPosts } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";

export async function BbsLatest() {
  const posts = await getLatestPosts(8);
  if (!posts.length) return null;
  return (
    <div id="bbs_latest" className="box">
      <Link href="/bbs" target="_blank">
        <h2>论坛新帖</h2>
      </Link>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          {posts.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="level">【{BBS_BOARD_NAMES[p.board]}】</span>
                <Link href={`/bbs/${p.id}`} target="_blank">
                  {p.title.length > 16 ? p.title.slice(0, 16) + "…" : p.title}
                </Link>
              </td>
              <td className="time">{timeOpposite(p.lastReplyTime, TIME_NEVER)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
