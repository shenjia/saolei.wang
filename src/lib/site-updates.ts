// 更新历史读取层（2026-11-02：/page/history 落库，后台 /admin/updates 可编辑）
//
// 存量口径（原 page.tsx 硬编码时代约定，落库后保持不变）：
// ① 年份从新到旧排列；② 每年内部按日期倒序（最新在前）；
// ③ date 存展示串「Y.M.D」（月/日不补零），排序/分组在读取层解析后计算。

import { prisma } from "@/lib/db";

export interface SiteUpdateRow {
  id: number;
  /** 展示日期串，如 "2026.10.29"（不补零，沿用存量风格） */
  date: string;
  content: string;
}

/** 解析「Y.M.D」串 → [y, m, d]；非法格式返回 null（后台校验层已挡，防御性兜底） */
export function parseSiteUpdateDate(s: string): [number, number, number] | null {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return [y, mo, d];
}

/** 校验并归一后台提交的日期：接受 Y.M.D / YYYY-MM-DD，统一归成「Y.M.D」展示串 */
export function normalizeSiteUpdateDate(raw: string): string | null {
  const s = raw.trim().replace(/-/g, ".");
  const p = parseSiteUpdateDate(s);
  if (!p) return null;
  return `${p[0]}.${p[1]}.${p[2]}`;
}

/** 全量更新历史，排好序的扁平列表（新在前） */
export async function getSiteUpdates(): Promise<SiteUpdateRow[]> {
  const rows = await prisma.siteUpdate.findMany({
    select: { id: true, date: true, content: true },
  });
  return rows
    .map((r) => ({
      id: Number(r.id),
      date: r.date,
      content: r.content,
      key: parseSiteUpdateDate(r.date) ?? [0, 0, 0],
    }))
    .sort((a, b) => {
      const [ay, am, ad] = a.key;
      const [by, bm, bd] = b.key;
      return by - ay || bm - am || bd - ad;
    })
    .map(({ id, date, content }) => ({ id, date, content }));
}

/** 按年分组（年份从新到旧，组内新在前），前台 /page/history 直接渲染用 */
export async function getSiteUpdatesByYear(): Promise<[string, SiteUpdateRow[]][]> {
  const rows = await getSiteUpdates();
  const years: [string, SiteUpdateRow[]][] = [];
  for (const row of rows) {
    const y = row.date.slice(0, row.date.indexOf("."));
    let bucket = years.find(([ky]) => ky === y);
    if (!bucket) {
      bucket = [y, []];
      years.push(bucket);
    }
    bucket[1].push(row);
  }
  return years;
}
