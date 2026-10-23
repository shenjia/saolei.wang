// 论坛新帖（移植 2008 版首页 BBS/Index_New.asp）：单行列表 + [板块] + 标题 + .精
// 2026-09-24 张老师要求：去掉标题前的黄色方块与行尾 M-D 日期（腾出宽度让长标题显示更全）
// 2026-09-26 张老师要求：分类标签与论坛列表页同款徽章渲染（board_tag 四板块配色）

import Link from "next/link";
import { BBS_BOARD_NAMES, getLatestPosts } from "@/lib/bbs";
import { HOME_BBS_NUMBER } from "@/lib/config";

export async function BbsLatest() {
  // 2026-10-14：8 → 6 条，为右栏顶部「开一局」大按钮腾出高度，保持首页左右栏底部基本对齐
  // 2026-10-15：首页新闻/录像各减 1 条（17→16）后，实测 bbs 6 条时两栏底差 +6px（7 条则右栏长 24px），
  // 故维持 6 条为最优对齐（条数移入 config 统一管理）
  const posts = await getLatestPosts(HOME_BBS_NUMBER);
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
                  <span
                    className={
                      "board_tag" +
                      (p.board === 0
                        ? " notice"
                        : p.board === 1
                          ? " tech"
                          : p.board === 3
                            ? " qa"
                            : "")
                    }
                  >
                    {BBS_BOARD_NAMES[p.board]}
                  </span>
                  {/* 2026-10-23（张老师）：取消论坛高亮——首页新帖标题不再加 .high 白显 */}
                  <Link href={`/bbs/${p.id}`} target="_blank" className="t">
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
