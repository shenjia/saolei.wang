// 更新历史（移植 2008 版 History/2006-2008.asp；2026-11-02 起落库 site_update 表，
// 后台 /admin/updates 可编辑，本页只读渲染）
// 约定：① 年份从新到旧排列；② 每年内部按日期倒序（最新在前）；
//       ③ 今后任何重大新功能上线，都必须在此登记一条，保持历史完整。
import { getSiteUpdatesByYear } from "@/lib/site-updates";

export const metadata = { title: "更新历史" };
// 后台可编辑，页面必须及时反映改动；低频页直接动态渲染
export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const YEARS = await getSiteUpdatesByYear();
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>更新历史</h1>
        {YEARS.map(([year, items]) => (
          <div className="hist_year_block" key={year}>
            {/* 2026-10-15 张老师要求：每个年度做成筛选器样式（金色 + 下方细线），
                用 h2 保留文档层级，样式由 globals.css 的 .hist_year 接管 */}
            <h2 className="hist_year">{year}年</h2>
            {items.map((it) => (
              <p key={it.id}>
                <em>{it.date}</em>　{it.content}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
