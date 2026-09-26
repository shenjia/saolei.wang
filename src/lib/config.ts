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
  time: "时间记录",
  "3bvs": "3BVS记录", // 2026-09-24 张老师定：写法用 3BVS（不带斜杠），2013 版原文是 3BV/s
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

export const VIDEO_PAGESIZE = 20;
export const HOME_TOP_NUMBER = 10;
export const HOME_NEWBIE_NUMBER = 5;
// 首页「动态」初始条数（2026-09-24 张老师要求：30 → 20 → 15，标题由「雷界快讯」改「动态」）
export const HOME_NEWS_NUMBER = 15;
// 首页「最新录像」初始条数（2026-09-24 新增版块，初值 20 → 15）
export const HOME_VIDEO_NUMBER = 15;

// ---------- 评论（移植 CommentConfig） ----------
// 2026-09-26 张老师要求：录像页初始最多显示 10 条，其余走「加载更多」
export const COMMENT_TOP_NUMBER = 10;
export const COMMENT_PAGESIZE = 15;
export const COMMENT_CONTENT_LIMIT = 100;
export const COMMENT_STATUS = { NORMAL: 0, DELETED: -1 } as const;

// 动态「加载更多」每页条数（移植 NewsConfig::PAGESIZE）
export const NEWS_PAGESIZE = 20;
// 用户主页动态初始条数（2026-09-24 张老师要求 15 → 10）
export const USER_NEWS_NUMBER = 10;
// 用户主页历程初始条数（2026-09-24 张老师要求与动态一致改 10）
export const USER_HISTORY_NUMBER = 10;
// 用户主页录像版块初始条数（2026-09-26 张老师要求默认 10 条，与动态/纪事同口径）
export const USER_VIDEO_NUMBER = 10;

// ---------- 军衔（移植 TitleConfig） ----------

export const TITLES = [
  "大元帅", "元帅", "大将", "上将", "中将", "少将",
  "大校", "上校", "中校", "少校",
  "上尉", "中尉", "少尉",
  "上士", "中士", "下士",
  "上等兵", "列兵",
] as const;

export const TITLE_CLASSES: Record<string, string> = {
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
export const TITLE_CLASS_COLORS: Record<string, string> = {
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

// 军衔评定使用 总计时间（sum_time）
export const TITLE_LEVEL: Level = "sum";
export const TITLE_ORDER: Order = "time";

// 固定编制军衔（前 6 个按人数，其余按比例，移植 TitleConfig）
export const FIXED_TITLES = ["大元帅", "元帅", "大将", "上将", "中将", "少将"] as const;

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
// 颜色照搬 saolei.net-2008/asp/Models/Css/2008.css 的同名 class

export const OLD_TITLES: { name: string; color: string; condition: string }[] = [
  { name: "雷帝", color: "#ffff00", condition: "雷界排行第一人" },
  { name: "雷圣", color: "#FFCC00", condition: "高级纪录 50 秒以内" },
  { name: "雷神", color: "#66CC00", condition: "高级纪录 50～60 秒（GG）" },
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

export const VIDEO_STATUS = {
  BANNED: 0,
  NORMAL: 10,
  REVIEWED: 20,
} as const;

export const VIDEO_STATUS_NAMES: Record<number, string> = {
  0: "已屏蔽",
  10: "待审核",
  20: "已通过",
};

// 3BV 小于该值时 3BV/s 成绩不被承认（显示删除线）
export const MIN_3BV_FOR_3BVS = 4;

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
} as const;

/** 首页「新闻」流可见的动态类型（2026-09-24 张老师定：注册/头像/发帖/评论动态只上个人主页，不进首页新闻） */
export const NEWS_HOME_TYPES: number[] = [
  NEWS_TYPE.NOTICE,
  NEWS_TYPE.NEWBIE,
  NEWS_TYPE.PERSON_RECORD,
  NEWS_TYPE.AREA_RECORD,
  NEWS_TYPE.NATION_RECORD,
  NEWS_TYPE.VIDEO,
];

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

// ---------- 地区显示名（合规表述；链接/查询仍用数据库原值） ----------

export const AREA_DISPLAY: Record<string, string> = {
  香港: "中国香港",
  澳门: "中国澳门",
  台湾: "中国台湾",
};

export function areaDisplay(name: string): string {
  return AREA_DISPLAY[name] ?? name;
}
