// Next 服务实例启动钩子：import 各查询模块触发其定义处的 registerPreheat()
// （注册行紧跟各自的 unstable_cache 条目，见 queries.ts / title-system.ts / practice.ts）。
// register() 在服务就绪前调用一次；任务本身 fire-and-forget，不阻塞就绪。
// 就绪门（__incrementalCache / NEXT_PHASE）在 preheat.ts tick() 内处理。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await Promise.all([import("./lib/queries"), import("./lib/title-system"), import("./lib/practice")]);
  }
}
