// 「转到第 N 页」下拉（2008 版分页 select，onChange 即跳转）

"use client";

import { buildUrl } from "./Pager";

export function GotoSelect({
  base,
  params,
  maxPage,
}: {
  base: string;
  params: Record<string, string | number | undefined>;
  maxPage: number;
}) {
  return (
    <select
      className="goto_select"
      defaultValue=""
      onChange={(e) => {
        const p = parseInt(e.target.value, 10);
        if (p > 0) window.location.href = buildUrl(base, { ...params, page: p });
      }}
    >
      <option value="">转到</option>
      {Array.from({ length: maxPage }, (_, i) => (
        <option key={i + 1} value={i + 1}>
          第{i + 1}页
        </option>
      ))}
    </select>
  );
}
