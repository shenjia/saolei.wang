// 分页器与筛选标签（移植 Pager / Tabs 组件的链接形态）

import Link from "next/link";

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `${base}?${q}` : base;
}

export function Pager({
  base,
  params,
  page,
  total,
  pageSize,
}: {
  base: string;
  params: Record<string, string | number | undefined>;
  page: number;
  total: number;
  pageSize: number;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // 2026-10-15 张老师要求：只有一页时也显示翻页控件，但按钮全灰不可点
  const single = pageCount <= 1;
  const links: (number | "...")[] = [];
  const push = (v: number | "...") => {
    if (links[links.length - 1] !== v) links.push(v);
  };
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= 2) push(p);
    else push("...");
  }
  return (
    <div className={"pager" + (single ? " single" : "")}>
      {page > 1 && !single ? (
        <Link href={buildUrl(base, { ...params, page: page - 1 })} className="prev">
          上一页
        </Link>
      ) : (
        single && <span className="prev off">上一页</span>
      )}
      {links.map((p, i) =>
        p === "..." ? (
          <span key={`e${i}`} className="ellipsis">
            …
          </span>
        ) : p === page ? (
          <span key={p} className="current">
            {p}
          </span>
        ) : (
          <Link key={p} href={buildUrl(base, { ...params, page: p })}>
            {p}
          </Link>
        )
      )}
      {page < pageCount && !single ? (
        <Link href={buildUrl(base, { ...params, page: page + 1 })} className="next">
          下一页
        </Link>
      ) : (
        single && <span className="next off">下一页</span>
      )}
    </div>
  );
}

/** 筛选项标签组（移植 Tabs 组件；ul/li 结构对齐 legacy CSS 的 .tabs li 规则） */
export function Tabs({
  base,
  params,
  name,
  options,
  current,
}: {
  base: string;
  params: Record<string, string | number | undefined>;
  name: string;
  options: [string, string][];
  current: string;
}) {
  return (
    <ul className="tabs" data-name={name}>
      {options.map(([value, label]) =>
        value === current ? (
          <li key={value} className="current">
            <em className="active">{label}</em>
          </li>
        ) : (
          <li key={value}>
            <Link href={buildUrl(base, { ...params, [name]: value, page: undefined })}>
              {label}
            </Link>
          </li>
        )
      )}
    </ul>
  );
}

export { buildUrl };
