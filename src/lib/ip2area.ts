// IP → 省份归属（2026-10-28 排行延迟埋点改按 IP 归属地统计，张老师要求）
// 数据源：ip2region-ts 内置离线 xdb（2025-08 版，纯本地查询零外呼零 key）。
// ⚠️ next.config.ts 的 serverExternalPackages 必须含 "ip2region-ts"：
//    bundler 打包会破坏包内 defaultDbFile 的 __dirname 相对路径 → 运行时找不到 xdb。
// 口径：region 格式「国家|0|省份|城市|ISP」，实测（2025-08 版数据）自治区/直辖市/港澳
//       字段已无后缀（内蒙古/广西/宁夏/西藏/新疆/北京/天津/重庆/香港），仅普通省与
//       「台湾省」带「省」——统一剥「省」后即与 GEO_PROVINCES / user.area 同口径。
import { defaultDbFile, isValidIp, loadContentFromFile, newWithBuffer } from "ip2region-ts";
import { getClientIp } from "@/lib/net";

type Searcher = ReturnType<typeof newWithBuffer>;

let searcher: Searcher | null = null;
function getSearcher(): Searcher {
  // 全量 xdb（11MB）一次载入内存常驻，查询零 IO；进程内单例
  return (searcher ??= newWithBuffer(loadContentFromFile(defaultDbFile)));
}

/** 解析 IP 归属省份（剥后缀省名）；失败/内网/境外/IPv6 返回空串——延迟地图宁缺毋假 */
export async function ipToArea(ip: string): Promise<string> {
  if (!ip || !isValidIp(ip)) return "";
  try {
    const { region } = await getSearcher().search(ip);
    if (!region) return "";
    const parts = region.split("|");
    if (parts[0] !== "中国") return ""; // 境外一律不计入国内地图
    const prov = parts[2] ?? "";
    if (!prov || prov === "0") return "";
    return prov.endsWith("省") ? prov.slice(0, -1) : prov;
  } catch {
    return "";
  }
}

export { getClientIp };
