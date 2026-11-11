// 环境切换胶囊（2026-11-11 张老师需求）：管理后台顶栏「管理后台」左侧，
// 左「生产」右「测试」，按当前域名高亮所在环境，点击另一侧跳到对应环境的同一路径。
// · 测试判定：dev.saolei.wang / localhost / 127.0.0.1 / 内网 IP；
//   其余（saolei.wang、www、rank-hk 等子域）一律算生产。
// · host 由服务端 layout 经 headers() 传入——SSR 首帧即正确高亮，无 hydration 抖动；
//   跳转目标在点击时读 window.location 现场拼（pathname+search+hash 原样带过去）。

"use client";

const PROD_ORIGIN = "https://saolei.wang";
const DEV_ORIGIN = "https://dev.saolei.wang";

function isTestHost(host: string): boolean {
  const h = host.split(":")[0].toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/^(192\.168|10)\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "dev.saolei.wang") return true;
  return false;
}

export function EnvSwitch({ host }: { host: string }) {
  const onTest = isTestHost(host);
  const go = (env: "prod" | "test") => {
    const target = env === "test" ? DEV_ORIGIN : PROD_ORIGIN;
    if (window.location.origin === target) return; // 已在目标环境，不跳
    window.location.href =
      target + window.location.pathname + window.location.search + window.location.hash;
  };
  return (
    <div className="env_switch" role="group" aria-label="环境切换">
      <button
        type="button"
        className={onTest ? "" : "on"}
        title={`当前：${host}`}
        onClick={() => go("prod")}
      >
        生产
      </button>
      <button
        type="button"
        className={onTest ? "on" : ""}
        title={`当前：${host}`}
        onClick={() => go("test")}
      >
        测试
      </button>
    </div>
  );
}
