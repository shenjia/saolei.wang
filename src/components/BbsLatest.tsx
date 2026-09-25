// 论坛新帖（移植 2008 版首页 BBS/Index_New.asp）：12px 小字单行列表 + [板块] + 标题 + .精
// 2026-09-24 张老师要求：去掉标题前的黄色方块与行尾 M-D 日期（腾出宽度让长标题显示更全）

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
          {posts.map((p) => (
            <tr key={p.id}>
              <td className="subject">
                <div className="wrap">
                  <span className="bname">[{BBS_BOARD_NAMES[p.board]}]</span>
                  <Link
                    href={`/bbs/${p.id}`}
                    target="_blank"
                    className={"t" + (p.isTop ? " high" : "")}
                  >
                    {p.title}
                  </Link>
                  {p.isPinned && <span className="pin">▲</span>}
                  {p.isNice && <span className="nice">.精</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
