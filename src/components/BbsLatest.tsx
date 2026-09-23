// 论坛新帖（移植 2008 版首页 BBS/Index_New.asp）：12px 小字单行列表 + 黄点 + [板块] + M-D 短日期

import Link from "next/link";
import { BBS_BOARD_NAMES, getLatestPosts } from "@/lib/bbs";

export async function BbsLatest() {
  const posts = await getLatestPosts(8);
  if (!posts.length) return null;
  return (
    <div id="bbs_latest" className="box">
      <Link href="/bbs" target="_blank">
        <h2>论坛新帖</h2>
      </Link>
      <table cellPadding={0} cellSpacing={0} className="bbs_new">
        <tbody>
          {posts.map((p) => {
            const d = new Date(p.lastReplyTime);
            return (
              <tr key={p.id}>
                <td className="subject">
                  <div className="wrap">
                    <img src="/images/Yellow.gif" width={7} height={25} alt="" />
                    <span className="bname">[{BBS_BOARD_NAMES[p.board]}]</span>
                    <Link
                      href={`/bbs/${p.id}`}
                      target="_blank"
                      className={"t" + (p.isTop ? " high" : "")}
                    >
                      {p.title}
                    </Link>
                    {p.isNice && <span className="nice">.精</span>}
                  </div>
                </td>
                <td className="date">
                  {d.getMonth() + 1}-{d.getDate()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
