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
      env: { NEXT_DIST_DIR: ".next-blue" },
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
      env: { NEXT_DIST_DIR: ".next-green" },
      watch: false,
      max_memory_restart: "1G",
      max_restarts: 5,
      restart_delay: 30000,
      merge_logs: true,
      time: true,
    },
  ],
};
