/**
 * SQL 拼装防护工具（2026-10-27 张老师要求加固，配合 2146257 的 assertVideoLevel）。
 *
 * 背景：全站仍有 74 处 `$queryRawUnsafe`。值一律走 `?` 占位符是首选，但**表名 /
 * 列名 / ASC·DESC / 运算符**这类东西占位符接不了，只能拼字符串——这是唯一还
 * 存在「未来手滑变真漏洞」的缝隙。本模块把「能拼的东西」收敛成自证函数：
 * 越界形态在运行时立刻抛错（fail fast 进日志 500），而不是静默拼进 SQL。
 *
 * 使用约定：
 *  - 值（用户输入、名称、关键词）→ 绝不进 SQL 串，走 `?` 占位符；确需 LIKE 时用 likeContains()
 *  - 标识符（列名、表名、别名.列名）→ assertIdent() 包一层
 *  - 结构片段（WHERE 串、ORDER BY 串）→ 由上面的白名单拼出，本身不再接受外部输入
 */

/** 标识符白名单：`col` 或 `tbl.col`，仅字母数字下划线，禁止反引号/空格/注释符 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * 断言字符串是合法 SQL 标识符（表名/列名/限定列名）。
 * 不合法直接抛错——宁可 500 进日志，也不让脏值拼进 SQL。
 */
export function assertIdent(v: string): string {
  if (!IDENT_RE.test(v)) {
    throw new Error(`assertIdent: 非法 SQL 标识符 ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * 转义 LIKE 通配符，让 `%` `_` `\` 恢复字面义（依赖 MySQL 默认反斜杠转义）。
 * 不转义的话，用户搜 `a_b` 会命中 `axb`、搜 `%` 会匹配全表——不是注入，
 * 但结果集被打宽（后台导出、公开 API 都吃这个亏）。
 */
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** 包含匹配参数：`%kw%`，通配符按字面义。直接塞进 `?` 占位符用。 */
export function likeContains(v: string): string {
  return `%${escapeLike(v)}%`;
}

/**
 * 由正整数列表生成 `?,?,?` 片段（配 `IN (...)` 用）。
 * 列表本身只接受已经过 Number.isInteger 校验的正整数，这里再兜一道。
 */
export function idPlaceholders(ids: readonly number[]): string {
  if (!ids.length) throw new Error("idPlaceholders: 空列表");
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`idPlaceholders: 非法 id ${JSON.stringify(id)}`);
    }
  }
  return ids.map(() => "?").join(",");
}
