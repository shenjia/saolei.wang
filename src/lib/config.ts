// 扫雷网领域配置，移植自 2013 版 PHP 的 *Config.php

export const LEVELS = ["beg", "int", "exp", "sum"] as const;
export type Level = (typeof LEVELS)[number];

export const ORDERS = ["time", "3bvs"] as const;
export type Order = (typeof ORDERS)[number];

// time 升序（越小越好），3bvs 降序（越大越好）
export const ORDER_DIRECTION: Record<Order, "asc" | "desc"> = {
  time: "asc",
  "3bvs": "desc",
};

export const LEVEL_NAMES: Record<Level | "all", string> = {
  all: "全部",
  beg: "初级",
  int: "中级",
  exp: "高级",
  sum: "总计",
};

export const ORDER_NAMES: Record<Order, string> = {
  time: "时间纪录",
  "3bvs": "3BVS纪录", // 2026-09-24 张老师定：写法用 3BVS（不带斜杠），2013 版原文是 3BV/s
};

export const RANKING_PAGESIZE = 20;

// ---------- 排行榜排序列（2008 版 By 参数：级别×成绩类型合成一列） ----------
export const RANKING_BYS = [
  "beg_time", "beg_3bvs",
  "int_time", "int_3bvs",
  "exp_time", "exp_3bvs",
  "sum_time", "sum_3bvs",
] as const;
export type RankingBy = (typeof RANKING_BYS)[number];

export function parseRankingBy(v?: string): RankingBy {
  return (RANKING_BYS as readonly string[]).includes(v ?? "") ? (v as RankingBy) : "sum_time";
}

/** by 拆成级别 + 成绩类型（复用 SCORE_FIELD 命名规则） */
export function byLevelOrder(by: RankingBy): { level: Level; order: Order } {
  const [level, order] = by.split("_") as [Level, Order];
  return { level, order };
}

// ---------- BV 收集榜排序列（2026-10-13 张老师需求：排行榜 NF 后新增 BV 榜） ----------
export const BV_RANKING_BYS = ["total", "beg", "int", "exp"] as const;
export type BvRankingBy = (typeof BV_RANKING_BYS)[number];

export function parseBvRankingBy(v?: string): BvRankingBy {
  return (BV_RANKING_BYS as readonly string[]).includes(v ?? "") ? (v as BvRankingBy) : "total";
}

export const VIDEO_PAGESIZE = 20;
export const HOME_TOP_NUMBER = 10;
export const HOME_NEWBIE_NUMBER = 5;
// 首页「新闻」初始条数（2026-09-24 张老师要求：30 → 20 → 15，标题由「雷界快讯」改「动态」；
// 2026-10-15 张老师要求 15 → 17 → 16，与录像同为 16 条（左右栏底部对齐口径））
export const HOME_NEWS_NUMBER = 16;
// 首页「最新录像」初始条数（2026-09-24 新增版块，初值 20 → 15；
// 2026-10-15 张老师要求 15 → 17 → 16）
export const HOME_VIDEO_NUMBER = 16;
// 首页侧栏「论坛新帖」条数（2026-10-14 为「开一局」按钮 8 → 6；
// 2026-10-15 首页两版块各减 1 条后实测：6 条时左右栏底部仅差 6px，7 条则右栏长出 24px，故维持 6）
export const HOME_BBS_NUMBER = 6;

// ---------- 评论（移植 CommentConfig） ----------
// 2026-09-26 张老师要求：录像页初始最多显示 10 条，其余走「加载更多」
export const COMMENT_TOP_NUMBER = 10;
export const COMMENT_PAGESIZE = 15;
export const COMMENT_CONTENT_LIMIT = 100;
export const COMMENT_STATUS = { NORMAL: 0, DELETED: -1 } as const;

// ---------- UGC 内容审核状态（2026-10-13 引入 AI 后置审核） ----------
// comment / bbs_post / bbs_reply 三张表共用同一套 status 语义：
//    0  正常（公开，计入条数）
//    5  AI 判定可疑 → 转人工复核（对外不公开，不计入条数）
//   -1  删除 / 屏蔽（软删，不公开）
// 前台查询一律 where status = 0，因此待审内容自动不展示、无需改各页查询。
export const CONTENT_STATUS = { NORMAL: 0, PENDING: 5, DELETED: -1 } as const;

/** 该状态是否计入冗余条数（video_stat.comments / bbs_post.replies）——仅正常态计入 */
export function countsInTotal(status: number): boolean {
  return status === CONTENT_STATUS.NORMAL;
}

/** 状态中文名（管理后台展示用） */
export const CONTENT_STATUS_NAMES: Record<number, string> = {
  0: "正常",
  5: "待审",
  "-1": "已删除",
};

// 动态「加载更多」每页条数（移植 NewsConfig::PAGESIZE）
export const NEWS_PAGESIZE = 20;
// 用户主页动态初始条数（2026-09-24 张老师要求 15 → 10；2026-10-15 张老师要求 10 → 12）
export const USER_NEWS_NUMBER = 12;
// 用户主页历程初始条数（2026-09-24 张老师要求与动态一致改 10；2026-10-15 张老师要求 10 → 12）
export const USER_HISTORY_NUMBER = 12;
// 用户主页录像版块初始条数（2026-09-26 张老师要求默认 10 条，与动态/纪事同口径；2026-10-15 张老师要求 10 → 12）
export const USER_VIDEO_NUMBER = 12;

// （2026-10-18 张老师定：军衔制回归 19 档总司令~列兵——人神界体系撤销，本节回退 10-16 定稿版）
// ---------- 军衔（移植 TitleConfig） ----------

export const TITLES = [
  "总司令", "大元帅", "元帅", "大将", "上将", "中将", "少将",
  "大校", "上校", "中校", "少校",
  "上尉", "中尉", "少尉",
  "上士", "中士", "下士",
  "上等兵", "列兵",
] as const;

export const TITLE_CLASSES: Record<string, string> = {
  总司令: "supreme",
  大元帅: "grand",
  元帅: "marshal",
  大将: "general", 上将: "general", 中将: "general", 少将: "general",
  大校: "colonel", 上校: "colonel", 中校: "colonel", 少校: "colonel",
  上尉: "captain", 中尉: "captain", 少尉: "captain",
  上士: "sergeant", 中士: "sergeant", 下士: "sergeant",
  上等兵: "private", 列兵: "private",
  // 预备役：未加入排行的玩家（2026-09-23 新增，用 legacy 的 new 灰色）
  预备役: "new",
};

// 军衔配色，与全站文字色一致（用于分布图条形等场景）
// 注意：grand 按 2026-09-23 张老师要求用元帅同款金黄 #e6db74（globals.css 已覆盖 legacy 深红 #c60d46）
// 2026-10-16 新增 supreme（总司令，第 19 级 SUB30）：首页标题金 #fdc61a（张老师定，与暗金区分一档）
export const TITLE_CLASS_COLORS: Record<string, string> = {
  supreme: "#fdc61a",
  grand: "#e6db74",
  marshal: "#e6db74",
  general: "#f79646",
  colonel: "#e26b0a",
  captain: "#9bbb59",
  sergeant: "#b1b1a4",
  private: "#939387",
  new: "#636359",
};

export const TITLE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(TITLE_CLASSES).map(([t, c]) => [t, TITLE_CLASS_COLORS[c] ?? "#668cba"])
);

// 军衔评定使用 高级时间（exp_time）
// 2026-10-13 张老师改版：由总计时间相对阈值（distribution 表）改为高级时间绝对阈值（SUB 制）
export const TITLE_LEVEL: Level = "exp";
export const TITLE_ORDER: Order = "time";

// 各军衔的高级时间上限（毫秒，与 TITLES 按下标一一对应：
// 大元帅=35s … 上等兵=150s；列兵无上限（>150s 即列兵））
// 2026-10-16 张老师新增总司令档（SUB30）；2026-10-19 张老师改口径：
// 总司令不再按 SUB30 绝对阈值，改「雷界排行第一人」（总计时间 TOP1，与旧体系「雷帝」同源），
// 由 title(score, isKing) 特判评定，不占阈值档位——本数组收窄为大元帅~上等兵 18 档（总司令/列兵不占档）
export const TITLE_THRESHOLDS: number[] = [
  35000, 40000, 42000, 45000, 48000, 50000, 52000, 55000, 58000, 60000,
  63000, 66000, 70000, 80000, 90000, 100000, 150000,
];

// 军衔卡片/详情页的条件文案（放人数下方一行、暗灰居中，如「高级纪录 < 40秒」，数字稍亮）
// 值为 [前缀, 数字] 二元组；数字部分渲染时用 <em> 提亮（预备役无数字，第二段为整段文案）
// 总司令（2026-10-19 改口径）：条件=雷界排行第一人，无数字段
export const TITLE_CONDITIONS: Record<string, [string, string]> = {
  总司令: ["雷界排行第一人", ""],
  大元帅: ["高级纪录 < ", "35秒"],
  元帅: ["高级纪录 < ", "40秒"],
  大将: ["高级纪录 < ", "42秒"],
  上将: ["高级纪录 < ", "45秒"],
  中将: ["高级纪录 < ", "48秒"],
  少将: ["高级纪录 < ", "50秒"],
  大校: ["高级纪录 < ", "52秒"],
  上校: ["高级纪录 < ", "55秒"],
  中校: ["高级纪录 < ", "58秒"],
  少校: ["高级纪录 < ", "60秒"],
  上尉: ["高级纪录 < ", "63秒"],
  中尉: ["高级纪录 < ", "66秒"],
  少尉: ["高级纪录 < ", "70秒"],
  上士: ["高级纪录 < ", "80秒"],
  中士: ["高级纪录 < ", "90秒"],
  下士: ["高级纪录 < ", "100秒"],
  上等兵: ["高级纪录 < ", "150秒"],
  列兵: ["高级纪录 ≥ ", "150秒"],
  预备役: ["未加入排行", ""],
};

/** 军衔条件文案 → 纯文本（气泡 tooltip 用，如「高级纪录 < 40秒」） */
export function titleConditionText(t: string): string {
  const c = TITLE_CONDITIONS[t];
  return c ? c[0] + c[1] : "";
}

// 固定编制军衔（2013 版按人数编制，2026-10-13 改 SUB 绝对阈值制后仅作历史参考，不再参与评定；
// 总司令 2026-10-16 新增、大校 2026-10-17 除名，均不属现行编制体系，不列入）
export const FIXED_TITLES = ["大元帅", "元帅", "大将", "上将", "中将", "少将"] as const;

// 2013 版按比例编制（历史参考，SUB 制下不再使用；总司令同理不列入）
export const TITLE_DISTRIBUTION: Record<string, number> = {
  大元帅: 1,
  元帅: 10,
  大将: 30,
  上将: 60,
  中将: 100,
  少将: 150,
  大校: 0.03,
  上校: 0.07,
  中校: 0.12,
  少校: 0.18,
  上尉: 0.25,
  中尉: 0.33,
  少尉: 0.42,
  上士: 0.52,
  中士: 0.63,
  下士: 0.75,
  上等兵: 0.88,
  列兵: 1.0,
};

// ---------- 旧版称号（2008 版，按高级纪录评定，军衔页旁列参考） ----------
// 颜色照搬 saolei.net-2008/asp/Models/Css/2008.css 的同名 class；
// 例外（2026-10-18 张老师三轮定色，原 2008 版黄/绿太刺眼）：
//   雷帝=#FFCC00、雷圣=#e6db74（互换）、雷神=上尉绿 #9bbb59

export const OLD_TITLES: { name: string; color: string; condition: string }[] = [
  { name: "雷帝", color: "#FFCC00", condition: "雷界排行第一人" },
  { name: "雷圣", color: "#e6db74", condition: "高级纪录 50 秒以内" },
  { name: "雷神", color: "#9bbb59", condition: "高级纪录 50～60 秒（GG）" },
  { name: "雷仙", color: "#FFCCCC", condition: "高级纪录 50～60 秒（mm）" },
  { name: "状元", color: "#ffffff", condition: "高级纪录 60～61 秒" },
  { name: "榜眼", color: "#ffffff", condition: "高级纪录 61～63 秒" },
  { name: "探花", color: "#ffffff", condition: "高级纪录 63～66 秒" },
  { name: "进士", color: "#e0e0e0", condition: "高级纪录 66～70 秒" },
  { name: "举人", color: "#cccccc", condition: "高级纪录 70～80 秒" },
  { name: "秀才", color: "#aaaaaa", condition: "高级纪录 80～90 秒" },
  { name: "书生", color: "#888888", condition: "高级纪录 90～100 秒" },
  { name: "童生", color: "#777777", condition: "高级纪录 100 秒以上" },
  { name: "布衣", color: "#666666", condition: "未加入排行" },
];

// ---------- 评级（移植 GradeConfig） ----------

export const GRADES = ["SSS", "SS", "S", "A", "B", "C", "D", "E", "F"] as const;

export const GRADE_PERCENTS = [100, 90, 80, 70, 60, 50, 35, 15, 5];

// ---------- 录像（移植 VideoConfig） ----------

export const VIDEO_LEVELS = ["beg", "int", "exp"] as const;
export type VideoLevel = (typeof VIDEO_LEVELS)[number];

// 录像列表排序列（2026-10-15 张老师需求：表头点击排序，去掉右侧排序 tabs）。
// id=上传时间（默认，倒序）；time=成绩（升序，快在前）；3bv=3BV（降序，大在前）；
// 3bvs=3BV/s（降序，快在前，排除运气盘：初级 3BV<10、中/高级 3BV<4，见 MIN_3BV_FOR_3BVS）；
// comments/clicks=评论/点击（降序，多在前）
// 2026-10-20 张老师需求：新增 ioe/stnb（效率/判雷，video_metrics 指标列，降序大在前，
// 无指标行的录像不参与排序——老录像跑批已全量覆盖，仅个别解析失败/屏蔽盘缺行）
export const VIDEO_LIST_ORDERS = [
  "id",
  "time",
  "3bv",
  "3bvs",
  "ioe",
  "stnb",
  "comments",
  "clicks",
] as const;
export type VideoListOrder = (typeof VIDEO_LIST_ORDERS)[number];

export function parseVideoListOrder(v?: string): VideoListOrder {
  return (VIDEO_LIST_ORDERS as readonly string[]).includes(v ?? "") ? (v as VideoListOrder) : "id";
}

/** 时间成绩搜索输入（秒）：1-3 位整数，最多 3 位小数（如 37 / 37.2 / 37.29） */
export const VIDEO_TIME_INPUT_RE = /^\d{1,3}(?:\.\d{1,3})?$/;

/** 3BV 搜索输入：1-3 位整数（2~999，与站内 3BV 值域一致） */
export const VIDEO_3BV_INPUT_RE = /^\d{1,3}$/;

/** 3BV 搜索输入 → 3BV 值（1~999 内合法；0 不合法——无 3BV 为 0 的有效录像） */
export function parseVideo3bv(v?: string): number | null {
  if (!v || !VIDEO_3BV_INPUT_RE.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= 1 && n <= 999 ? n : null;
}

/**
 * 时间成绩搜索输入 → 匹配窗口 [lo, hi)（毫秒）。
 * 「匹配所有时间相同的成绩」= 显示值相同（scoreTime 按 2 位小数四舍五入），
 * 故窗口取显示舍入半径 ±5ms：输入 37.29 → [37285, 37295)，覆盖所有显示为 37.29 的成绩。
 */
export function parseVideoTimeWindow(t?: string): [number, number] | null {
  if (!t || !VIDEO_TIME_INPUT_RE.test(t)) return null;
  const ms = Math.round(parseFloat(t) * 1000);
  return [ms - 5, ms + 5];
}

export const VIDEO_STATUS = {
  BANNED: 0,
  NORMAL: 10,
  REVIEWED: 20,
} as const;

/**
 * 封禁时长选项（2026-10-16 限时封禁）：[key, 文案, 秒]（0 = 永久）。
 * 放在纯常量模块：后台弹窗（客户端组件）与 lib/ban.ts（服务端）共用。
 */
export const BAN_DURATIONS: [string, string, number][] = [
  ["1d", "一天", 24 * 3600],
  ["7d", "一周", 7 * 24 * 3600],
  ["30d", "一月", 30 * 24 * 3600],
  ["365d", "一年", 365 * 24 * 3600],
  ["0", "永久", 0],
];

export const VIDEO_STATUS_NAMES: Record<number, string> = {
  0: "已屏蔽",
  10: "待审核",
  20: "已通过",
};

// 3BV 小于该值时 3BV/s 成绩不被承认（显示删除线）。
// 2026-10-16 张老师：初级限界由 3BV>=4 收紧为 3BV>=10（3BV=10 起 3BV/s 有效）；中/高级维持 4
// （上传下限 30/100 本就高于 4，该值对中/高级实际不约束）。
export const MIN_3BV_FOR_3BVS: Record<VideoLevel, number> = { beg: 10, int: 4, exp: 4 };

// 无效 3BV/s 的 hover 气泡文案（2026-10-13 张老师要求：hover 删除线成绩弹气泡说明无效原因）。
// 录像详情页与排行表共用同一条文案，改文案只改这里。
export const INVALID_3BVS_TIP = "因为3BV太小，运气成分过高，该3BV/s成绩不被承认";

// 棋盘尺寸（移植 board.js）
export const BOARD_SIZE: Record<VideoLevel, { x: number; y: number }> = {
  beg: { x: 8, y: 8 },
  int: { x: 16, y: 16 },
  exp: { x: 30, y: 16 },
};

// ---------- 用户角色（移植 UserConfig::ROLE_*） ----------
export const USER_ROLE = {
  PLAYER: 0,
  MANAGER: 10,
  ADMINISTRATOR: 100,
} as const;

export function isManager(role: number): boolean {
  return role === USER_ROLE.MANAGER || role === USER_ROLE.ADMINISTRATOR;
}

// ---------- 第三方登录（微信/QQ） ----------
// 本地测试阶段整体隐藏（2026-09-24 张老师）：登录入口只留账号密码，不强制绑定。
// 两平台申请落地后改回 true，恢复扫码登录 tab 与老用户强制绑定流程。
export const OAUTH_ENABLED = false;

// 上传录像各级别最小 3BV（移植 VideoConfig::$level_min_3bv）
export const LEVEL_MIN_3BV: Record<VideoLevel, number> = { beg: 2, int: 30, exp: 100 };

// ---------- 新闻（移植 NewsConfig） ----------

export const NEWS_TYPE = {
  NOTICE: 0,
  NEWBIE: 10,
  PERSON_RECORD: 20,
  AREA_RECORD: 21,
  NATION_RECORD: 22,
  VIDEO: 30, // 上传录像（2026-09-24 启用：每盘通过审核的录像一条）
  ARTICLE: 40, // 论坛文章（2026-09-24 启用）
  JOIN: 50, // 加入扫雷网（注册）
  AVATAR: 51, // 更换头像
  COMMENT: 52, // 评论（录像评论 / BBS 回帖）
  PROMOTION: 53, // 晋升军衔（2026-10-17 张老师要求整体下线：存量已删、回填脚本退役；
                 // 常量保留仅为类型编号存档，勿再写入/渲染）
} as const;

/** 首页「新闻」流可见的动态类型（2026-09-24 张老师定：注册/头像/发帖/评论动态只上个人主页，不进首页新闻）
 *  2026-10-17 张老师定：上传录像（VIDEO）撤出首页新闻——首页已有「录像」版块，
 *  录像动态一上传就刷屏新闻流（只在用户主页「动态」显示，NEWS_FEED_EXCLUDED）；
 *  同日再定：晋升动态（PROMOTION）整体下线，不再进入任何动态流 */
export const NEWS_HOME_TYPES: number[] = [
  NEWS_TYPE.NOTICE,
  NEWS_TYPE.NEWBIE,
  NEWS_TYPE.PERSON_RECORD,
  NEWS_TYPE.AREA_RECORD,
  NEWS_TYPE.NATION_RECORD,
];

/** 用户主页「动态」排除的类型（2026-10-17：与首页同口径撤掉上传录像；
 *  晋升动态存量已删，无需列入——此数组仅排除「仍会写入但不展示」的类型）。
 *  管理后台不受此口径影响 */
export const NEWS_FEED_EXCLUDED: number[] = [NEWS_TYPE.VIDEO, NEWS_TYPE.PROMOTION];

// ---------- 地区 ----------

// 注册可选地区：2008 版 Register_Input.asp 顺序（34 省级）+ 2013 版补充「海外」
// 落库存中文原值，显示时经 areaDisplay 合规化
export const AREA_LIST = [
  "北京", "上海", "天津", "重庆",
  "安徽", "福建", "甘肃", "广东", "广西", "贵州", "海南",
  "河北", "河南", "黑龙江", "湖北", "湖南", "吉林",
  "江苏", "江西", "辽宁", "内蒙古", "宁夏", "青海",
  "山东", "山西", "陕西", "四川", "西藏", "新疆", "云南", "浙江",
  "香港", "澳门", "台湾", "海外",
] as const;

// 「海外」用户（外国人，名字为外文中译）：显示「海外第 X 名」（组内名次，2026-10-15
// 张老师要求，口径与地区榜海外条目同构），不显示全国名；仍保留全国主榜名次本身
export const AREA_OVERSEAS = "海外";

// ---------- 地区显示名（合规表述；链接/查询仍用数据库原值） ----------

export const AREA_DISPLAY: Record<string, string> = {
  香港: "中国香港",
  澳门: "中国澳门",
  台湾: "中国台湾",
};

export function areaDisplay(name: string): string {
  return AREA_DISPLAY[name] ?? name;
}

// ---------- 地区榜榜序（地区排行页表头 + URL 参数解析；服务端与客户端组件共用） ----------
// 2026-10-13 张老师要求：去掉「平均排行」（平均全国名次意义不大），换成「活跃人数」（近 30 天登录人数）
export type AreaOrder = "power" | "players" | "active" | "best";

export const AREA_ORDERS: { key: AreaOrder; label: string }[] = [
  { key: "best", label: "领军人物" },
  { key: "players", label: "排行人数" },
  { key: "active", label: "活跃人数" },
  { key: "power", label: "综合排行指数" },
];

/** 榜序参数解析（未知/缺省一律回落到综合排行指数） */
export function parseAreaOrder(v?: string): AreaOrder {
  return AREA_ORDERS.find((o) => o.key === v)?.key ?? "power";
}
