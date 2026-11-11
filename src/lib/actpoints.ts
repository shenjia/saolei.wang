// 练习局逐盘活跃点计算（2026-11-08 张老师定稿）——**单一来源**：
// 服务端 /api/track/practice 落库与练习页客户端「活跃+N」实时自增共用同一函数，
// 防两处口径漂移。纯函数零依赖（客户端可安全打包）。
// 口径（2026-11-08 三修订）：初级胜=1 败=0；中级胜=2、败局完成率≥50%=1；
// 高级完成率≥50% 按 floor(率×10)（败局 5~9 点，胜局 solvedBv=bbbv 恒=10）；
// 自定义胜=1（无固定难度防刷）。
// 修订史：初版高级门槛 20%（2~10 点）——当日即被套利（35627 扫到 20% 即重开
// 刷出单日 2099 点、平均 1.98 点/盘卡死 20%~29% 区间），21:01 张老师定改过半。
// 整数运算防浮点取整误差（直接 solvedBv/bbbv>=0.5 会踩 0.7×10=6.999… floor 成 6 的坑）。
// 2026-11-11 张老师定：恢复本版 1/2/10 原口径（中级过半败局计 1 点），排行模式与
// 在线练习（非排行）**同口径**——取消 50% 减半。第 5 参 ranked 仅为兼容 core 私有
// submodule 客户端「活跃+N」的 5 参调用保留，本函数不再读取；core 侧注释若仍提
// 「减半」属历史文案，一律以本文件为准。
export function practiceActPoints(
  level: string,
  won: boolean,
  bbbv: number,
  solvedBv: number,
  ranked?: boolean,
): number {
  void ranked; // 两模式同口径，仅作签名兼容（避免 core 侧 TS2554）
  if (level === "exp") {
    // 高级：完成率≥50%（过半）给 floor(率×10)（败局 5~9 点）；胜局恒得 10
    return solvedBv * 2 >= bbbv ? Math.floor((solvedBv * 10) / bbbv) : 0;
  }
  if (level === "int") {
    if (won) return 2; // 中级完成=2
    return solvedBv * 2 >= bbbv ? 1 : 0; // 败局完成率≥50% 给 1
  }
  return won ? 1 : 0; // 初级/自定义：完成=1 不成=0
}
