// Next 服务实例启动钩子：加载缓存自驱动预热任务清单（src/lib/preheat-jobs.ts）。
// register() 在服务就绪前调用一次；任务本身 fire-and-forget，不阻塞就绪。
// 就绪门（__incrementalCache / NEXT_PHASE）在 preheat.ts tick() 内处理。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/preheat-jobs");
  }
}
