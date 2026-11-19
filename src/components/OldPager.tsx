// 老式分页条（移植 2008 版 Ranking_All 底部：共 N 位 首页|上一页|下一页|末页 现在是第 x/y 页 转到）

import Link from "next/link";
import { buildUrl } from "./Pager";
import { GotoSelect } from "./GotoSelect";

export function OldPager({
  base,
  params,
  page,
  total,
  pageSize,
  unit = "位",
}: {
  base: string;
  params: Record<string, string | number | undefined>;
  page: number;
  total: number;
  pageSize: number;
  unit?: string;
}) {
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const url = (p: number) => buildUrl(base, { ...params, page: p });
  return (
    <div className="old_pager">
      共&nbsp;<em>{total}</em>&nbsp;{unit}&nbsp;&nbsp;
      {page > 1 ? (
        <>
          <Link href={url(1)}>首页</Link>&nbsp;|&nbsp;<Link href={url(page - 1)}>上一页</Link>
        </>
      ) : (
        <>
          <span>首页</span>&nbsp;|&nbsp;<span>上一页</span>
        </>
      )}
      {page < maxPage ? (
        <>
          &nbsp;|&nbsp;<Link href={url(page + 1)}>下一页</Link>&nbsp;|&nbsp;
          <Link href={url(maxPage)}>末页</Link>
        </>
      ) : (
        <>
          &nbsp;|&nbsp;<span>下一页</span>&nbsp;|&nbsp;<span>末页</span>
        </>
      )}
      &nbsp;&nbsp;现在是第&nbsp;<em>{page}</em>
      <span className="max">/{maxPage}</span>&nbsp;页&nbsp;
      <GotoSelect base={base} params={params} maxPage={maxPage} />
    </div>
  );
}
