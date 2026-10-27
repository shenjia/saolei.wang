/**
 * ecosystem.config.js —— pm2 进程配置（saolei 蓝绿双槽）
 *
 * - saolei / saolei-green：蓝绿双槽，由 scripts/server-deploy.sh 管理（勿手动重启单槽）。
 *   next start 经 NEXT_DIST_DIR 读对应槽位的构建产物（.next-blue / .next-green）。
 * - 服务器 node 为系统安装版（/usr/bin/node v22），无受管版本，interpreter 用 PATH 默认。
 */
module.exports = {
  apps: [
    {
      name: "saolei",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3100",
      cwd: __dirname,
      env: { NEXT_DIST_DIR: ".next-blue", RANKED_MODE_OPEN: "1", RANKED_PENALTY_DELAY: "1" },
      watch: false,
      max_memory_restart: "1G",
      // crash loop 防护（09-27 教训：槽位产物未就绪时 pm2 无限重启 1287 次
      // 持续烧 CPU/IO，30 秒内连挂 5 次即停手等人工介入）
      max_restarts: 5,
      restart_delay: 30000,
      merge_logs: true,
      time: true,
    },
    {
      name: "saolei-green",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3102",
      cwd: __dirname,
      env: { NEXT_DIST_DIR: ".next-green", RANKED_MODE_OPEN: "1", RANKED_PENALTY_DELAY: "1" },
      watch: false,
      max_memory_restart: "1G",
      max_restarts: 5,
      restart_delay: 30000,
      merge_logs: true,
      time: true,
    },
    {
      // 排名模式权威对局：**双实例热备**（2026-10-27 张老师定，替代原先的单进程排空）。
      // 对局状态在各自进程内存里、两槽互不可见，所以不是负载均衡而是热备：
      //   - nginx 只把新连接给 active 那台（authority-upstream.conf 的 # active 行）
      //   - 发布时重建备槽（跑新代码）→ 切 nginx → 老槽等存量局 natural 打完再重建
      //   - 全程不拒新局，玩家无感；两槽都要常驻（standby 挂了切换就没兜底）
      // ⚠️ gameId 带槽位前缀（a-/b-），Next 侧按前缀把 /finalize 发到对局所在槽。
      name: "saolei-authority-a",
      script: "src/core/scripts/authority/server.mjs",
      cwd: __dirname,
      env: { AUTHORITY_SLOT: "a", AUTHORITY_PORT: "3104" },
      watch: false,
      max_memory_restart: "256M",
      max_restarts: 5,
      restart_delay: 3000,
      merge_logs: true,
      time: true,
    },
    {
      name: "saolei-authority-b",
      script: "src/core/scripts/authority/server.mjs",
      cwd: __dirname,
      env: { AUTHORITY_SLOT: "b", AUTHORITY_PORT: "3105" },
      watch: false,
      max_memory_restart: "256M",
      max_restarts: 5,
      restart_delay: 3000,
      merge_logs: true,
      time: true,
    },
  ],
};
