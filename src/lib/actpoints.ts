// 练习局逐盘活跃点计算（2026-11-08 张老师定稿）——**单一来源**：
// 服务端 /api/track/practice 落库与练习页客户端「活跃+N」实时自增共用同一函数，
// 防两处口径漂移。纯函数零依赖（客户端可安全打包）。
// 口径：初级胜=1 败=0；中级胜=2、败局完成率≥50%=1；高级完成率≥20% 按
// floor(率×10)（胜局 solvedBv=bbbv 恒=10）；自定义胜=1（无固定难度防刷）。
// 整数运算防浮点取整误差（直接 solvedBv/bbbv>=0.2 会踩 0.3×10=2.999… floor 成 2 的坑）。
export function practiceActPoints(
  level: string,
  won: boolean,
  bbbv: number,
  solvedBv: number,
): number {
  if (level === "exp") {
    // 高级：完成率≥20% 给 floor(率×10)（2~10 点）；胜局恒得 10
    return solvedBv * 10 >= bbbv * 2 ? Math.floor((solvedBv * 10) / bbbv) : 0;
  }
  if (level === "int") {
    if (won) return 2; // 中级完成=2
    return solvedBv * 2 >= bbbv ? 1 : 0; // 败局完成率≥50% 给 1
  }
  return won ? 1 : 0; // 初级/自定义：完成=1 不成=0
}
