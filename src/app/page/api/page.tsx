// 开放 API 说明页（2026-10-24）
// 站内对外入口：footer「开放API」链到本页。内容与 docs/partner-api-openms.md 同源，
// 面向想接入的第三方开发者（机器人 / 数据同步服务）。
// 2026-10-24 二轮（张老师要求）：每个接口详细列出输入参数表 + 响应示例（JSON），
// 页面自足可读，不必跳 GitHub；接口区块用 <details> 折叠（默认展开，长页可收起）。
// 2026-10-27：首屏新增接口导航表（锚点跳转到对应区块）——导航行直接由 APIS 数组
// 生成，**今后加减接口只改 APIS 数组一处**，导航表自动跟随，无需单独维护。

import Link from "next/link";

export const metadata = { title: "开放 API" };

interface ParamDoc {
  name: string;
  required?: boolean;
  desc: string;
}

interface ApiDoc {
  path: string;
  title: string;
  /** 一句话简介（首屏接口导航表用） */
  brief: string;
  desc: string;
  params: ParamDoc[];
  request: string;
  response: string;
  notes?: string[];
}

const APIS: ApiDoc[] = [
  {
    path: "/api/public/v1/stats",
    title: "站点统计",
    brief: "全站总量统计 + 最大 id（增量抓取定位用）",
    desc: "首页「站点统计」版块同口径数据 + 两个最大 ID（确定增量抓取范围、减少试探请求用）。无参数。",
    params: [],
    request: "GET /api/public/v1/stats",
    response: `{
  "generatedAt": 1792555559,
  "stats": {
    "userTotal": 34085,
    "rankedTotal": 7371,
    "videoTotal": 307494,
    "videoCommentTotal": 54198,
    "bbsTopicTotal": 2839,
    "bbsReplyTotal": 17949,
    "practiceTotal": 3163
  },
  "maxVideoId": 345159,
  "maxUserId": 35488
}`,
    notes: [
      "userTotal 注册人数（排除封禁）· rankedTotal 排行人数（有成绩且未封禁）· videoTotal 录像数（待审+已通过）",
      "maxVideoId / maxUserId 供增量抓取定位上界",
    ],
  },
  {
    path: "/api/public/v1/video_list",
    title: "录像列表（增量同步）",
    brief: "按 id 升序全量/增量拉取录像元数据",
    desc: "按录像 id 升序分页拉取全部审核状态的录像；cursor 断点续拉，可用 player_id 只拉取指定玩家。配合 stats.maxVideoId 可做「全量对账 + 增量追加」。",
    params: [
      { name: "cursor", desc: "上次响应的 nextCursor，首次不传" },
      { name: "since", desc: "Unix 秒，跳过该时间之前上传的（仅首次全量可选用；与 cursor 同给时 cursor 优先）" },
      { name: "level", desc: "beg / int / exp，缺省 = 全部" },
      { name: "player_id", desc: "玩家 ID，提供后只返回该玩家的录像；需为大于 0 的整数" },
      { name: "size", desc: "每页条数，默认 200，上限 1000" },
    ],
    request: "GET /api/public/v1/video_list?player_id=1&cursor=0&size=2",
    response: `{
  "cursor": 0,
  "nextCursor": 25,
  "hasMore": true,
  "size": 2,
  "generatedAt": 1792555559,
  "items": [
    {
      "id": 24,
      "level": "beg",
      "userId": 1,
      "userName": "张砷镓",
      "hash": "4cd9e3e261f76888be8d8919f06d0428",
      "status": 20,
      "uploadTime": 1167978360,
      "reviewTime": 1167978403,
      "realTime": 1110,
      "board3bv": 4,
      "3bvs": -3604,
      "nf": true,
      "software": "Clone",
      "version": "0.97"
    }
  ]
}`,
    notes: [
      "status：0=已屏蔽 / 10=待审 / 20=已通过；列表不按审核状态过滤，调用方可按需自行筛选",
      "realTime 毫秒；3bvs 已按站内口径算好（ROUND(board_3bv×1e6/real_time)），负值 = 运气盘（初级 3BV<10、中高级 3BV<4），成绩不被站内承认",
      "nf: true = 无标雷（NF）录像；列表不含录像文件，需要文件用 video_info 的 fileUrl，网页回放链到 https://saolei.wang/video/{id}",
    ],
  },
  {
    path: "/api/public/v1/video_info",
    title: "录像详情（含重放指标 + 录像文件 URL）",
    brief: "单个/批量录像全量公开数据 + 重放指标 + 文件下载地址",
    desc: "返回录像全部已落盘公开数据：video_list 全部字段 + signature（录像内嵌玩家标识）+ metrics（离线重放引擎算得的落盘指标）+ fileUrl（录像文件完整 URL）。",
    params: [{ name: "id", required: true, desc: "逗号分隔的录像 ID，最多 50 个" }],
    request: "GET /api/public/v1/video_info?id=328090",
    response: `{
  "generatedAt": 1792555559,
  "items": [
    {
      "id": 328090,
      "level": "exp",
      "userId": 18290,
      "userName": "鞠泽恩",
      "hash": "6d58634fbe0987003dda90f4a68944a7",
      "status": 20,
      "uploadTime": 1753974216,
      "reviewTime": 1754020972,
      "realTime": 25100,
      "board3bv": 123,
      "3bvs": 4900,
      "nf": false,
      "fileUrl": "https://saolei.wang/videos/2025/07/31/6d58634fbe0987003dda90f4a68944a7.avf",
      "software": "Arbiter",
      "version": "0.52",
      "signature": "Ju Ze En",
      "metrics": {
        "cl": 150,
        "clLeft": 95,
        "clRight": 22,
        "clDouble": 33,
        "ce": 124,
        "path": 363,
        "ioe": 0.82,
        "stnb": 223.3
      }
    }
  ]
}`,
    notes: [
      "status：10=待审 / 20=已通过（屏蔽 0 不返回）",
      "fileUrl：录像文件（MVF/EVF 等）完整下载地址，直接 GET 即得文件本体；该类文件全站限速 3 次/秒，批量拉取请自行排队",
      "metrics：cl 总点击（左+右+双）· ce 有效点击 · path 鼠标行程（16px/格折算）· ioe 效率（3BV/总点击）· stnb 判雷指标；null = 该录像重放指标尚未落盘",
      "点击计数为站内 flop 引擎口径，与其他站点的派生口径可能不同，请勿混用",
    ],
  },
  {
    path: "/api/public/v1/user_info",
    title: "玩家详情",
    brief: "公开信息 + 双体系成绩 + 录像标识列表",
    desc: "公开信息 + 双体系成绩（标准 / NF，各级 time、3bvs 附达成录像 ID）+ 录像标识列表。",
    params: [{ name: "id", required: true, desc: "逗号分隔的玩家 ID，最多 50 个" }],
    request: "GET /api/public/v1/user_info?id=1",
    response: `{
  "generatedAt": 1792555560,
  "users": [
    {
      "id": 1,
      "name": "张砷镓",
      "englishName": "Zhang Shen Jia",
      "sex": 1,
      "area": "陕西",
      "registeredAt": 1167758493,
      "banned": false,
      "scores": {
        "beg": { "time": 980, "timeVideoId": 154, "3bvs": 7289, "3bvsVideoId": 4807 },
        "int": { "time": 10310, "timeVideoId": 15129, "3bvs": 5301, "3bvsVideoId": 9262 },
        "exp": { "time": 37820, "timeVideoId": 9195, "3bvs": 4226, "3bvsVideoId": 8212 },
        "sum": { "time": 49110, "3bvs": 16816 }
      },
      "scoresNf": {
        "beg": { "time": 980, "timeVideoId": 154, "3bvs": 5614, "3bvsVideoId": 8079 },
        "int": { "time": 11540, "timeVideoId": 9428, "3bvs": 4601, "3bvsVideoId": 12093 },
        "exp": { "time": 52220, "timeVideoId": 10614, "3bvs": 3720, "3bvsVideoId": 16200 },
        "sum": { "time": 64740, "3bvs": 13835 }
      },
      "signatures": ["张砷镓", "zsj"]
    }
  ]
}`,
    notes: [
      "banned: true 的账号不带成绩（与站内「封禁不在榜」口径一致）",
      "*VideoId = 0 表示该列无关联录像；area 已做合规显示名处理（香港 → 中国香港）",
      "signatures 为该玩家自注册的录像签名归属（本站特有数据）",
    ],
  },
  {
    path: "/api/public/v1/user_list",
    title: "玩家列表（轻量）",
    brief: "批量补齐玩家基础信息 + 8 列合计成绩",
    desc: "批量补齐玩家基础信息的轻量版：字段同 user_info 但不含 scoresNf / signatures / 逐级录像指针（scores 为 8 列合计成绩）。",
    params: [{ name: "id", required: true, desc: "逗号分隔的玩家 ID，最多 100 个" }],
    request: "GET /api/public/v1/user_list?id=1,2",
    response: `{
  "generatedAt": 1792555560,
  "users": [
    {
      "id": 1,
      "name": "张砷镓",
      "englishName": "Zhang Shen Jia",
      "sex": 1,
      "area": "陕西",
      "registeredAt": 1167758493,
      "banned": false,
      "scores": {
        "begTime": 980,
        "beg3bvs": 7289,
        "intTime": 10310,
        "int3bvs": 5301,
        "expTime": 37820,
        "exp3bvs": 4226,
        "sumTime": 49110,
        "sum3bvs": 16816
      }
    }
  ]
}`,
  },
  {
    path: "/api/public/v1/post_info",
    title: "帖子查询",
    brief: "按 id 批量取帖子基本信息（不含正文）",
    desc: "按 id 查询帖子基本信息：标题、分类、发布者、发布时间、更新时间、最后回复时间、评论数、点击数、置顶/加精/锁定状态。不含正文——正文请引导用户访问 https://saolei.wang/bbs/{id}。",
    params: [{ name: "id", required: true, desc: "逗号分隔的帖子 ID，最多 50 个" }],
    request: "GET /api/public/v1/post_info?id=362,177",
    response: `{
  "generatedAt": 1792555560,
  "items": [
    {
      "id": 362,
      "title": "扫雷定式及变化",
      "board": 1,
      "userId": 1,
      "userName": "张砷镓",
      "postTime": 1181620008,
      "updateTime": 1201508595,
      "lastReplyTime": 1637886023,
      "replies": 35,
      "clicks": 187923,
      "pinned": false,
      "nice": true,
      "locked": false
    }
  ]
}`,
    notes: [
      "board：0=公告 / 1=技术 / 2=杂谈 / 3=问答",
      "postTime 发布时间 · updateTime 最后编辑时间（改帖/加精/置顶等写操作，非最后回复）· lastReplyTime 最后回复时间",
      "pinned 置顶 · nice 加精 · locked 锁定",
      "只返回正常帖；已删除帖、待审帖（仅本人与管理员站内可见）不返回",
    ],
  },
  {
    path: "/api/public/v1/post_search",
    title: "帖子关键词查询",
    brief: "标题关键词搜索，前 20 条/页，cursor 翻页",
    desc: "按关键词匹配帖子标题（站内论坛搜索同口径，不含正文与回复），返回前 20 条帖子基本信息（字段同 post_info，不含正文），cursor 断点翻页。",
    params: [
      { name: "keyword", required: true, desc: "搜索关键词，限 30 字；匹配帖子标题（包含匹配）" },
      { name: "cursor", desc: "上次响应的 nextCursor，首次不传；翻页取更早（id 更小）的结果" },
    ],
    request: "GET /api/public/v1/post_search?keyword=扫雷",
    response: `{
  "cursor": 0,
  "nextCursor": 23979,
  "hasMore": true,
  "keyword": "扫雷",
  "size": 20,
  "generatedAt": 1793089487,
  "items": [
    {
      "id": 24361,
      "title": "予我以扫雷——加入竞速扫雷的一些心路历程",
      "board": 2,
      "userId": 33769,
      "userName": "孙沁晗",
      "postTime": 1791446702,
      "updateTime": 1792679104,
      "lastReplyTime": 1791567522,
      "replies": 14,
      "clicks": 364,
      "pinned": false,
      "nice": false,
      "locked": false
    }
  ]
}`,
    notes: [
      "按 id 倒序（新帖在前）；每页固定 20 条，hasMore=false 时 nextCursor 为 null",
      "只搜正常帖；标题匹配为包含匹配，% _ 等通配符按字面处理",
      "keyword 与站内 /bbs 搜索一致只匹配标题，不匹配正文与作者名",
    ],
  },
];

export default function ApiPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>开放 API</h1>
        <p>
          扫雷网对外提供结构化数据接口，供机器人、数据分析等第三方服务接入。
          所有接口均需凭 <b>API Key</b> 调用，请勿抓取站内页面（已有限速与反爬措施，页面抓取方式不可用或极慢）。
        </p>

        <h2>申请 Key</h2>
        <p>
          API Key 由站长签发。请通过站内私信、论坛或 QQ 群联系管理员，
          说明你的项目用途与合作方名称，审核通过后即可获得专用 Key（格式 <code>sk-…</code>）。
          Key 请妥善保管，请勿泄露或提交进公开仓库；丢失可联系重签。
        </p>

        <h2>调用方式</h2>
        <p>所有请求携带请求头：</p>
        <pre className="api_code">
          <code>X-Api-Key: 你的key</code>
        </pre>
        <ul className="api_brief">
          <li>无 Key / 错误 Key：<code>401</code>；请求过频：<code>429</code>（限 60 次/分钟，按合作方计）</li>
          <li>全量同步建议控制在 30 次/分钟以内；增量同步每小时一次即可</li>
          <li>所有时间戳均为 Unix 秒；time 类成绩为毫秒，3bvs 为实际值（整数）</li>
          <li>数据仅限公开展示口径，不含任何联系方式、IP 等隐私字段</li>
          <li>引用数据时请注明来源：扫雷网 saolei.wang</li>
        </ul>

        {/* 接口导航（2026-10-27 张老师要求）：首屏总表，点击跳到对应接口区块。
            行数据直接映射 APIS 数组——加减接口只改上面 APIS 一处，此表自动跟随。
            配色（张老师 16:37 定）：说明列白、功能列亮灰（.api_nav 修饰类区分参数表）。 */}
        <h2>接口导航</h2>
        <table className="api_table api_nav">
          <thead>
            <tr>
              <th style={{ width: 64 }}>方法</th>
              <th style={{ width: 260 }}>接口</th>
              <th style={{ width: 90 }}>说明</th>
              <th>功能</th>
            </tr>
          </thead>
          <tbody>
            {APIS.map((api) => (
              <tr key={api.path}>
                <td>
                  <span className="api_method">GET</span>
                </td>
                <td>
                  <a className="api_nav_link" href={`#api-${api.path.split("/").pop()}`}>
                    <code>{api.path}</code>
                  </a>
                </td>
                <td className="api_nav_title">{api.title}</td>
                <td className="api_nav_brief">{api.brief}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>接口详情</h2>
        {APIS.map((api) => (
          <details key={api.path} id={`api-${api.path.split("/").pop()}`} className="api_endpoint" open>
            <summary>
              <span className="api_method">GET</span>
              <code>{api.path}</code>
              <span className="api_ep_title">{api.title}</span>
            </summary>
            <div className="api_ep_body">
              <p className="api_ep_desc">{api.desc}</p>

              <div className="api_sub">输入参数{api.params.length === 0 ? "：无" : ""}</div>
              {api.params.length > 0 && (
                <table className="api_table">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>参数</th>
                      <th style={{ width: 60 }}>必填</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {api.params.map((p) => (
                      <tr key={p.name}>
                        <td>
                          <code>{p.name}</code>
                        </td>
                        {/* 必填「是」金 /「否」亮灰，说明列正文亮灰（2026-10-27 张老师定） */}
                        <td>
                          <span className={p.required ? "api_req_yes" : "api_req_no"}>{p.required ? "是" : "否"}</span>
                        </td>
                        <td className="api_param_desc">{p.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="api_sub">请求示例</div>
              <pre className="api_code">
                <code>{api.request}</code>
              </pre>

              <div className="api_sub">返回示例</div>
              <pre className="api_code">
                <code>{api.response}</code>
              </pre>

              {api.notes && (
                <ul className="api_brief">
                  {api.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        ))}

        <p>
          快速验证：
          <code>curl -H &quot;X-Api-Key: 你的key&quot; https://saolei.wang/api/public/v1/stats</code>
        </p>

        <hr />
        <Link href="/page/about" className="button">
          了解本站
        </Link>
      </div>
    </div>
  );
}
