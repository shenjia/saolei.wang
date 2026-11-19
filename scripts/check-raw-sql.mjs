#!/usr/bin/env node
// 裸拼 SQL 护栏 v2（2026-11-02 口径升级，v1 见 git 历史）
//
// 为什么需要它：全站有 70+ 处 $queryRawUnsafe / $executeRawUnsafe。其中绝大多数是
// 「纯静态 SQL + ? 占位符」——值全部走参数化，本身没有注入面；真正的风险只有两类：
//   ① 把值（用户输入/名称/关键词）用 ${} 拼进 SQL 串 —— 注入漏洞本体
//   ② SQL 不是模板字面量而是变量传入（动态拼装，审无可审）
// v1 把所有调用点都数进基线，导致每加一条正常的聚合查询（GROUP BY/SUM 等 Prisma
// delegate 做不了的）都被点名，噪音淹没问题。v2 基线只盯「插值/动态」调用点：
//   - 静态 + 占位符的新增：不告警（想加就加，本来就该这么写）
//   - 插值/动态的新增：点名 + 自检清单 + 退出码 1（--warn 时只提示）
// 插值的合法场景只剩「占位符接不了的东西」：表名/列名/JSON path/ASC·DESC，
// 必须经 assertIdent()（src/lib/sqlguard.ts）或服务端白名单拼出——这就是自检清单。
//
// 用法：
//   node scripts/check-raw-sql.mjs            # 比对基线，有新增则退出码 1
//   node scripts/check-raw-sql.mjs --warn     # 只提示不失败（CI 用这个）
//   node scripts/check-raw-sql.mjs --update   # 复核确认无误后刷新基线
//
// 基线文件：scripts/raw-sql-baseline.json（变化会出现在 diff 里，等于强制过一次 review）

import fs from "node:fs";
import path from "node:path";

const ROOT = "src";
const BASELINE = "scripts/raw-sql-baseline.json";
const PATTERN = /\$(?:queryRawUnsafe|executeRawUnsafe)\s*(?:<[^>]*>)?\s*\(/g;

const args = new Set(process.argv.slice(2));
const warnOnly = args.has("--warn");
const update = args.has("--update");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 判断某调用点的 SQL 是否「动态」（需要基线盯防）：
 *  - 从调用点向后找第一个反引号：找不到（400 字符内）→ SQL 由变量传入，按动态算；
 *  - 找到模板字面量 → 扫到配对反引号，途中出现 ${ → 插值，按动态算。
 * 局限：${} 内嵌套反引号的写法（SQL 调用点不会这么写）会提前截断，属已知近似，
 * 宁可误报进自检，不可漏报——与 fail fast 的 sqlguard 同一哲学。
 */
function isDynamic(src, callIdx) {
  const head = src.slice(callIdx, callIdx + 400);
  const bt = head.indexOf("`");
  if (bt === -1) return true; // 非模板字面量（变量/拼接传入）→ 审无可审，盯防
  let i = callIdx + bt + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return false; // 模板闭合，全程无 ${ → 静态
    if (ch === "$" && src[i + 1] === "{") return true; // 插值 → 盯防
    i++;
  }
  return true; // 未闭合（异常形态）→ 盯防
}

/** 逐文件统计：all = 全部 raw 调用点（信息参考），dyn = 插值/动态调用点（基线盯防） */
function scan() {
  const all = {};
  const dyn = {};
  for (const p of walk(ROOT)) {
    const src = fs.readFileSync(p, "utf8");
    let nAll = 0;
    let nDyn = 0;
    for (const m of src.matchAll(PATTERN)) {
      nAll++;
      if (isDynamic(src, m.index)) nDyn++;
    }
    if (nAll > 0) {
      all[p] = nAll;
      if (nDyn > 0) dyn[p] = nDyn;
    }
  }
  return { all, dyn };
}

function sum(files) {
  return Object.values(files).reduce((a, b) => a + b, 0);
}

const now = scan();
const nowAllTotal = sum(now.all);
const nowDynTotal = sum(now.dyn);

if (update) {
  const payload = {
    note: "裸拼 SQL 基线 v2：只盯含 ${} 插值或动态传入 SQL 的调用点（静态+?占位符不设限）。新增插值点前请确认标识符过 assertIdent、LIKE 参数用 likeContains。",
    version: 2,
    generatedAt: new Date().toISOString().slice(0, 10),
    interpolatedTotal: nowDynTotal,
    interpolatedFiles: Object.fromEntries(Object.entries(now.dyn).sort(([a], [b]) => a.localeCompare(b))),
    allTotal: nowAllTotal,
  };
  fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + "\n");
  console.log(`基线已更新：插值/动态 ${nowDynTotal} 处 / 全部 raw ${nowAllTotal} 处 → ${BASELINE}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.log(`未找到基线 ${BASELINE}，跳过检查（当前插值/动态 ${nowDynTotal} 处 / 全部 raw ${nowAllTotal} 处）。`);
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

if (base.version !== 2) {
  console.log(`✗ 基线为旧版格式（v1，全体调用点计数），请执行 node scripts/check-raw-sql.mjs --update 迁移为 v2（只盯插值/动态）。`);
  process.exit(1);
}

const regressions = [];
for (const [file, n] of Object.entries(now.dyn)) {
  const old = base.interpolatedFiles?.[file] ?? 0;
  if (n > old) regressions.push(`新增/增加 ${n - old} 处插值/动态 SQL：${file}（基线 ${old} → 现 ${n}）`);
}
for (const file of Object.keys(base.interpolatedFiles ?? {})) {
  if (!(file in now.dyn)) console.log(`已减少/移除：${file}（基线 ${base.interpolatedFiles[file]} → 0）`);
}

const dynDelta = nowDynTotal - (base.interpolatedTotal ?? 0);
const staticDelta = (nowAllTotal - nowDynTotal) - ((base.allTotal ?? 0) - (base.interpolatedTotal ?? 0));

if (!regressions.length && dynDelta <= 0) {
  console.log(
    `✓ 插值/动态 SQL 无新增（${nowDynTotal} 处，基线 ${base.interpolatedTotal} 处${dynDelta < 0 ? `，已降 ${-dynDelta}` : ""}）` +
      (staticDelta > 0 ? `；静态占位符调用点 +${staticDelta}（不计入告警）` : "") +
      `，全部 raw ${nowAllTotal} 处`
  );
  process.exit(0);
}

console.log(`\n✗ 插值/动态 SQL 出现新增（${nowDynTotal} 处，基线 ${base.interpolatedTotal} 处）：`);
for (const r of regressions.sort()) console.log(`  · ${r}`);
console.log(`
插值只允许用于占位符接不了的东西（表名/列名/JSON path/ASC·DESC），自检：
  1. 值（用户输入/名称/关键词）必须走 ? 占位符，绝不拼进 SQL 串；
  2. 表名/列名等标识符是否经 assertIdent()（src/lib/sqlguard.ts）或服务端白名单？
  3. LIKE 参数是否用 likeContains() 转义 %/_ ？
确认后执行 node scripts/check-raw-sql.mjs --update 刷新基线（会进 diff，等于过审）。`);

if (warnOnly) {
  for (const r of regressions.sort()) console.log(`::warning::插值/动态 SQL 新增 · ${r}`);
  process.exit(0);
}
process.exit(1);
