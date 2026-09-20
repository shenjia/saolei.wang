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
  if (pageCount <= 1) return null;
  const links: (number | "...")[] = [];
  const push = (v: number | "...") => {
    if (links[links.length - 1] !== v) links.push(v);
  };
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= 2) push(p);
    else push("...");
  }
  return (
    <div className="pager">
      {page > 1 && (
        <Link href={buildUrl(base, { ...params, page: page - 1 })} className="prev">
          上一页
        </Link>
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
      {page < pageCount && (
        <Link href={buildUrl(base, { ...params, page: page + 1 })} className="next">
          下一页
        </Link>
      )}
    </div>
  );
}

/** 筛选项标签组（移植 Tabs 组件） */
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
    <span className="tabs" data-name={name}>
      {options.map(([value, label]) =>
        value === current ? (
          <em key={value} className="active">
            {label}
          </em>
        ) : (
          <Link key={value} href={buildUrl(base, { ...params, [name]: value, page: undefined })}>
            {label}
          </Link>
        )
      )}
    </span>
  );
}

export { buildUrl };
