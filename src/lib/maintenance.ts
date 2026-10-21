// 站点维护模式（2026-10-22，新旧站数据合并用）
// 管理后台一键开关：开启后所有产生新数据的用户入口统一返回
// 「本站正在维护中，请稍后再试」，管理员操作不受影响。
//
// 存储：site_flag 表（key/value，单行 upsert）——蓝绿双槽共享同一生产库，
// 开关状态天然跨槽一致、重启不丢，不需要环境变量或部署配置。
// 读取：每实例内存缓存 5 秒（维护窗口通常分钟级，5s 生效延迟可接受），
// 避免每个写请求都打一次 DB。

import { prisma } from "@/lib/db";

export const MAINTENANCE_FLAG_KEY = "maintenance_mode";
const CACHE_TTL_MS = 5_000;

let cached: { on: boolean; at: number } | null = null;

/** 当前是否处于维护模式（内存缓存 5s） */
export async function isMaintenanceOn(): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.on;
  let on = false;
  try {
    const row = await prisma.siteFlag.findUnique({ where: { key: MAINTENANCE_FLAG_KEY } });
    on = row?.value === "1";
  } catch {
    // 表未建/DB 异常时按「未维护」放行——维护开关是运维便利，不能反过来把全站写入口打死
    on = false;
  }
  cached = { on, at: Date.now() };
  return on;
}

/** 写开关（仅管理后台调用；value=true 时顺便作废本地缓存） */
export async function setMaintenance(on: boolean): Promise<void> {
  await prisma.siteFlag.upsert({
    where: { key: MAINTENANCE_FLAG_KEY },
    create: { key: MAINTENANCE_FLAG_KEY, value: on ? "1" : "0" },
    update: { value: on ? "1" : "0" },
  });
  cached = { on, at: Date.now() };
}

/** 维护模式统一拒绝响应（与各入口现有错误出口同构：JSON + 400） */
export function maintenanceReject(): Response {
  return Response.json({ error: "本站正在维护中，请稍后再试", maintenance: true }, { status: 503 });
}
