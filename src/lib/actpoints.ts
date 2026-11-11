// 练习局逐盘活跃点计算（2026-11-11 张老师定新口径）——**单一来源**：
// 服务端 /api/track/practice 落库与练习页客户端「活跃+N」实时自增共用同一函数，
// 防两处口径漂移。纯函数零依赖（客户端可安全打包）。
// 口径（2026-11-11 四轮修订）：初级胜=1 败=0；中级完成过半（≥50%）按完成率比例
// floor(4×率)（胜局 solvedBv=bbbv 恒=4，败局过半 2~3 点）；高级同口径 floor(20×率)
// （胜局恒=20，败局过半 10~19 点）。
// 非排行模式练习（ranked=false，练习局非排名局）只得 50% 练习点，向下取整——
// 排行模式（ranked=true）全额计点。⚠️ 初级胜局非排行 floor(1×50%)=0 点（引导上
// 排行模式）。自定义盘只存在于非排行模式（排行不支持自定义，张老师 11-11 指正），
// 经 50% 减半后恒=0 点=不计活跃点（张老师 11-11 定：接受 0 点）；函数内初级/自定义
// 共用胜=1 分支仅为代码分支复用，自定义实际产出恒为 0。
// 修订史：2026-11-08 初版中级胜=2、高级过半 floor(率×10)、自定义胜=1；2026-11-11 张老师定
// 权重改 1/4/20 且中高级过半一律按比例、练习局减半（自定义随之归零）。
// 整数运算防浮点取整误差（直接 solvedBv/bbbv>=0.5 会踩 0.7×10=6.999… floor 成 6 的坑）；
// 减半在 floor 之后再 floor：floor(floor(x)/2) === floor(x/2)（数学恒等，无二次误差）。
export function practiceActPoints(
  level: string,
  won: boolean,
  bbbv: number,
  solvedBv: number,
  ranked: boolean,
): number {
  let pts: number;
  if (level === "exp") {
    // 高级：完成率≥50%（过半）给 floor(20×率)（败局过半 10~19 点）；胜局恒得 20
    pts = solvedBv * 2 >= bbbv ? Math.floor((solvedBv * 20) / bbbv) : 0;
  } else if (level === "int") {
    // 中级：完成率≥50%（过半）给 floor(4×率)（败局过半 2~3 点）；胜局恒得 4
    pts = solvedBv * 2 >= bbbv ? Math.floor((solvedBv * 4) / bbbv) : 0;
  } else {
    pts = won ? 1 : 0; // 初级：完成=1 不成=0（自定义共用分支，减半后恒 0 点）
  }
  // 非排行模式练习只得 50% 练习点，向下取整（floor(floor(x)/2)===floor(x/2) 恒等）
  return ranked ? pts : Math.floor(pts / 2);
}
