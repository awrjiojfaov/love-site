/**
 * 剧情工坊 · 故事存档与提示词组装。
 * 每个账号的故事互不影响：全部存在本机 localStorage，按账号名分键。
 */

export type Relation = {
  id: string
  name: string // 人物名
  relation: string // 与主角的关系
  note: string // 补充（外貌/性格/背景等）
}

export type ChatCard = {
  title: string
  messages: { from: string; text: string }[]
}

export type StoryMsg = {
  role: 'user' | 'assistant'
  content: string // 展示用文本（已剥离【档案】等行）
  chat?: ChatCard // 本段附带的微信式聊天卡片
  ts: number
}

export type StorySetup = {
  heroName: string
  gender: string
  age: string
  personality: string
  appearance: string
  genre: string // 题材
  background: string // 背景设定
  outfit: string // 初始穿搭
  funds: string // 初始资金
  styles: string[] // 语言风格插件 id
  pluginIds?: string[] // 开局选用的写作插件 id（选择状态）
  plugins?: WritingPlugin[] // 选用插件的规则快照（随故事走，删插件不影响已开的故事）
}

export type StoryState = {
  funds: string
  status: string
  outfit: string
}

export type StoryScore = {
  happiness: number // 幸福指数 0-100
  brilliance: number // 精彩程度 0-100
  comment: string // 总评
}

export type Story = {
  id: string
  title: string
  setup: StorySetup
  worldview?: string // 开局自动补齐的世界观与人物前传
  state: StoryState
  relations: Relation[]
  msgs: StoryMsg[]
  createdAt: number
  updatedAt: number
  /** 待化解的危机简介；空值表示安全 */
  pendingCrisis?: string
  ended?: boolean
  endingType?: string // 手动完结 / 死亡
  bookName?: string // 完结命名
  score?: StoryScore
  uploaded?: boolean // 是否已上传榜单
  /** 题材玩法系统 id（修仙RPG 等），空为自由剧情模式 */
  system?: string
  /** 玩法面板当前值（境界/战力/资产/线索…），由 AI 每段结算 */
  panel?: Record<string, string>
  /** 物品栏：剧情中出现的全部道具/物品（"聚气丹×3" 格式），由 AI 每段全量同步 */
  items?: string[]
  /** 写作渠道：collab=双AI协作（默认）/ deepseek / doubao / gemini 独写（跳过润色，更快） */
  channel?: 'collab' | 'deepseek' | 'doubao' | 'gemini'
}

/* ---------------- 语言风格插件 ---------------- */

export type StylePlugin = { id: string; name: string; rule: string }

export const STYLE_PLUGINS: StylePlugin[] = [
  { id: 'cinema', name: '电影镜头感', rule: '用镜头语言写画面，有远景特写和调度感，像在放电影' },
  { id: 'daily', name: '烟火日常', rule: '生活流写法，细节真实接地气，像发生在身边的事' },
  { id: 'jianghu', name: '武侠江湖气', rule: '打斗写招式和节奏不写特效，对话带江湖口吻和侠气，有金庸式的留白' },
  { id: 'minguo', name: '民国旧梦', rule: '民国语感：黄包车、留声机、月份牌、洋楼，用词矜持克制，情书式含蓄' },
  { id: 'cyber', name: '赛博霓虹', rule: '霓虹雨夜、义体、巨企、数据流，语汇冷硬短促，科技感裹着孤独' },
  { id: 'horror', name: '怪谈惊悚', rule: '让日常渗出不协调感，细思极恐，靠氛围不靠鬼怪直给，结尾留凉意' },
  { id: 'healing', name: '治愈慢生活', rule: '节奏舒缓，认真写食物、天气和光影，小事写出发亮的感觉，读完心里发暖' },
  { id: 'angst', name: '虐心刀片', rule: '糖里藏刀：把美好写得越具体，失去的伏笔埋得越深，情绪要后知后觉地疼' },
  { id: 'lightnovel', name: '轻小说吐槽', rule: '允许内心 OS 和精准吐槽，节奏轻快，日轻式幽默，严肃场面也能破功' },
  {
    id: 'shuang',
    name: '爽文节奏',
    rule: '节奏快、爽点密：主角不吃瘪，有仇当场报，冲突三句话内见分晓；多写实力提升、打脸反杀、机缘到手，少写铺垫和内心戏；语言直白干脆，少用隐喻和留白',
  },
  {
    id: 'trend',
    name: '潮流前线',
    rule:
      '写现代题材时，用当下真实的潮流语汇：穿搭风格可写多巴胺穿搭、美拉德色系、格雷系、新中式、Miu系、芭蕾风、Y2K、Clean Fit、老钱风、户外机能风；' +
      '单品可写德训鞋、勃肯鞋、洞洞鞋、萨洛蒙、始祖鸟冲锋衣、lululemon、鲨鱼裤、短款羽绒服、新中式盘扣、马面裙、痛包、Labubu挂件；' +
      '场景可写谷子店、livehouse、手冲咖啡店、盲盒机前；不要写十年前的过时搭配和老土品牌',
  },
  {
    id: 'meme',
    name: '热梗网感',
    rule: '允许化用近两年的网络热梗和年轻人的说话方式，点到为止不堆砌，让角色说话像真实的当代年轻人',
  },
]

/* ---------------- 写作插件（创作者自制规则，开故事可选用） ---------------- */

export type WritingPlugin = { id: string; name: string; rule: string; createdAt: number }

const pluginKey = (userName: string) => `story-plugins-${userName}`

export function loadPlugins(userName: string): WritingPlugin[] {
  try {
    const raw = localStorage.getItem(pluginKey(userName))
    return raw ? (JSON.parse(raw) as WritingPlugin[]) : []
  } catch {
    return []
  }
}

function savePluginList(userName: string, list: WritingPlugin[]): WritingPlugin[] {
  localStorage.setItem(pluginKey(userName), JSON.stringify(list))
  return list
}

export function addPlugin(userName: string, name: string, rule: string): WritingPlugin[] {
  const list = loadPlugins(userName)
  list.unshift({ id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), rule: rule.trim(), createdAt: Date.now() })
  return savePluginList(userName, list)
}

export function editPlugin(userName: string, id: string, name: string, rule: string): WritingPlugin[] {
  const list = loadPlugins(userName).map((p) => (p.id === id ? { ...p, name: name.trim(), rule: rule.trim() } : p))
  return savePluginList(userName, list)
}

export function removePlugin(userName: string, id: string): WritingPlugin[] {
  return savePluginList(userName, loadPlugins(userName).filter((p) => p.id !== id))
}

/* ---------------- 题材玩法系统（RPG 面板） ---------------- */

export type GenreSystem = {
  id: string
  name: string
  match: RegExp // 按题材+背景关键词匹配
  fields: string[] // 面板字段（展示用）
  rules: string // 注入系统提示词的玩法规则
}

export const GENRE_SYSTEMS: GenreSystem[] = [
  {
    id: 'xiuxian',
    name: '修仙 RPG',
    match: /修仙|仙侠|修真|玄幻|洪荒|封神|飞升/,
    fields: ['境界', '灵根', '战力', '气运', '功法', '丹药法宝'],
    rules: [
      '【境界体系】凡人→练气→筑基→金丹→元婴→化神→炼虚→合体→大乘→渡劫→地仙→天仙→金仙→太乙→大罗→半圣→圣人→仙帝，每个大境界分初期/中期/后期/巅峰/圆满五小层，突破要有契机，不能坐火箭',
      '【灵根】凡根/灵根/上品灵根/极品灵根/先天道体/混沌圣体/鸿蒙道身，开局随机，影响修炼速度和战力加成',
      '【战力】由你自动计算并保持自洽：练气约100~500，筑基约500~2千，金丹约2千~1万，元婴约1万~5万，之后每个大境界约翻3~5倍；再按灵根、功法、法宝、丹药增益做加减；比对方战力差一个大境界以上，正面对抗基本必败',
      '【机缘】每3~5段可自然触发一次机缘：秘境、上古遗迹、残魂传承、灵泉、仙缘宝箱、神兽契约等，收获与风险并存',
      '【气运】薄/普通/深厚/滔天/天命/鸿蒙气运，影响机缘好坏，随剧情缓慢变化',
      '【渡劫】大境界突破可降下雷劫、心魔劫、情欲劫，按危机规则处理，应对不当会身死道消',
      '【丹药法宝】丹药（聚气丹、筑基丹、疗伤丹、破障丹等）和法宝（法器→宝器→灵器→仙器→神器→鸿蒙至宝）写进面板的丹药法宝栏，获得消耗都要结算',
    ].join('\n'),
  },
  {
    id: 'wuxia',
    name: '武侠江湖',
    match: /武侠|江湖|武林|侠客|门派|古龙|金庸/,
    fields: ['武学境界', '内力', '门派声望', '武功绝学', '兵器', '善恶值'],
    rules: [
      '【武学境界】三流→二流→一流→顶尖→宗师→大宗师→陆地神仙，内力随境界增长，招式境界差距决定比武下限',
      '【比武结算】胜负按境界+绝学+兵器+状态综合判定，跨两个大境界基本不可战胜，除非有合理布置（下毒、地形、暗算）',
      '【门派声望】随事迹涨跌，影响 NPC 态度与江湖人脉；善恶值影响正邪两道的反应',
      '【奇遇】每3~5段可触发一次：秘籍残页、前辈指点、神兵出世、仇家上门、英雄帖等',
    ].join('\n'),
  },
  {
    id: 'urban',
    name: '都市经营',
    match: /都市|现代|职场|商战|豪门|明星|娱乐圈|重生.*(都市|现代)|神豪/,
    fields: ['资产', '身份职业', '人脉', '随身物品', '声望'],
    rules: [
      '【资产结算】收入支出实时记账，大笔进账必须有合理来路（工资、投资、签约、奖金），禁止凭空暴富',
      '【机遇】每3~5段触发一次机遇或危机：贵人提携、风口项目、合同陷阱、舆论危机、对手狙击等',
      '【声望】影响路人、媒体和圈内人的态度；人脉记录关键关系人的好感与利用价值',
    ].join('\n'),
  },
  {
    id: 'mystery',
    name: '悬疑探案',
    match: /悬疑|推理|侦探|凶杀|破案|盗墓|谜案|刑侦/,
    fields: ['线索', '嫌疑人', '理智值', '随身道具', '危险度'],
    rules: [
      '【线索】每条线索自动编号记入面板（如「线索1：窗台半枚泥脚印」），必须来自剧情中真实的发现；关键线索可组合推理指向真相，也允许红鲱鱼误导',
      '【理智值】0~100，受惊吓、熬夜、血腥场面会下降，低于30会出现幻觉和误判，休息和陪伴可恢复',
      '【危险度】平静/暗涌/逼近/杀机四伏，真凶逼近时按危机规则处理，错误指认可能打草惊蛇',
    ].join('\n'),
  },
  {
    id: 'fantasy',
    name: '异世界冒险',
    match: /异世界|奇幻|魔法|西幻|魔幻|勇者|魔王|地下城|转生/,
    fields: ['等级', '职业', '技能', '魔力', '装备', '金币'],
    rules: [
      '【等级】打怪、完成任务获得经验升级，等级压制明显，越级挑战需要战术或道具弥补',
      '【技能】有冷却和魔力消耗，魔力见底就放不出技能；新技能要靠学习、领悟或卷轴',
      '【装备】普通→精良→稀有→史诗→传说，获得和损耗都记入面板；金币用于交易，收支要记账',
    ].join('\n'),
  },
  {
    id: 'apocalypse',
    name: '末日求生',
    match: /末日|末世|求生|丧尸|废土|灾变|生化/,
    fields: ['健康', '物资', '武器', '庇护所等级', '同伴', '存活天数'],
    rules: [
      '【物资】食物、水、药品、弹药每日消耗，入不敷出会扣健康；外出搜寻有收获也有风险',
      '【健康】受伤、饥饿、感染都会扣，归零即死亡（按危机规则写死亡结局）',
      '【同伴】可以招募也会背叛或死亡，每个同伴记入关系网；庇护所可升级加固',
    ].join('\n'),
  },
  {
    id: 'campus',
    name: '校园物语',
    match: /校园|青春|恋爱|高中|大学|同桌|社团/,
    fields: ['学业', '好感度', '零花钱', '心情', '日程'],
    rules: [
      '【好感度】对关键人物分别记录（如「好感度：林晚65/陈屿40」），随互动增减，关键选择大幅波动，到一定程度解锁告白、决裂等节点',
      '【学业】考试、比赛按学业值结算结果；零花钱收支要记账',
      '【心情】晴朗/平静/低落/雀跃，影响发挥和 NPC 观感',
    ].join('\n'),
  },
]

/** 按题材+背景匹配玩法系统，没匹配上就是自由剧情模式 */
export function detectGenreSystem(text: string): GenreSystem | null {
  return GENRE_SYSTEMS.find((s) => s.match.test(text)) ?? null
}

/** 当前故事启用的玩法系统 */
export function storySystem(story: Story): GenreSystem | null {
  return GENRE_SYSTEMS.find((s) => s.id === story.system) ?? null
}

/** 去 AI 味写作规则（与 DeepSeek 协作打磨后的版本，每次调用必带） */
const ANTI_AI_RULES = [
  '每段只写一个「此刻」，靠动作和对话带信息，禁止总结过去、预告未来',
  '每个自然段最多用一次人名或「她/他」作主语开头，改用物件、环境、动作起句',
  '细节要选「歪」的：不写青石板油纸伞这种标配场景，写门缝里夹着半张褪色电影票这种意外细节',
  '对话必须带肢体噪音：插嘴、没说完、答非所问，禁止一问一答的工整对白',
  '动作要拆碎成微步骤（伸手、碰到铜环、缩回来、用袖子擦、再推），不写「他推开门」这种成品动作',
  '情绪只用动作和生理反应写（指甲掐掌心、后颈发麻），禁止「她感到悲伤」这类直给',
  '剧情段落要停在半空中，禁止收束、禁止感叹、禁止点题',
  '允许无意义的重复词（「门，又是门」），每段不超过一次',
  '「像」「仿佛」「宛如」每段最多用一次，且必须接具体的东西（像吞了块冰），不接抽象词（像心碎）',
  '转折连词（但、却、然而）能不用就不用，用场景跳切代替',
].join('\n- ')

/* ---------------- 存档读写 ---------------- */

function storageKey(userName: string): string {
  return `story-books-${userName}`
}

export function loadStories(userName: string): Story[] {
  try {
    const raw = localStorage.getItem(storageKey(userName))
    const list = raw ? (JSON.parse(raw) as Story[]) : []
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function saveStories(userName: string, stories: Story[]): void {
  localStorage.setItem(storageKey(userName), JSON.stringify(stories))
}

export function upsertStory(userName: string, story: Story): Story[] {
  const list = loadStories(userName)
  const idx = list.findIndex((s) => s.id === story.id)
  story.updatedAt = Date.now()
  if (idx >= 0) list[idx] = story
  else list.unshift(story)
  saveStories(userName, list)
  return list
}

export function deleteStory(userName: string, id: string): Story[] {
  const list = loadStories(userName).filter((s) => s.id !== id)
  saveStories(userName, list)
  return list
}

/* ---------------- 提示词组装 ---------------- */

/** 系统提示词：叙事规则 + 去AI味 + 设定 + 档案 + 关系网 + 风格插件，每次调用全量同步 */
export function buildSystemPrompt(story: Story): string {
  const { setup, state } = story
  const sys = storySystem(story)
  const styleRules = setup.styles
    .map((id) => STYLE_PLUGINS.find((p) => p.id === id)?.rule)
    .filter(Boolean)
    .join('；')
  const customRules = (setup.plugins ?? [])
    .map((p) => `${p.name}：${p.rule}`)
    .filter(Boolean)
    .join('；')

  const relations =
    story.relations.length > 0
      ? story.relations.map((r) => `${r.name}（${r.relation}）${r.note ? '：' + r.note : ''}`).join('\n')
      : '（暂无其他人物，随剧情出现可补充）'

  return [
    '你是一位中文文字剧情游戏的主持人兼作家。',
    '',
    '【叙事规则】',
    `- 全程用第三人称叙述，称呼主角为「${setup.heroName}」，绝不出现"你"字`,
    '- 玩家的话默认视为故事中主角的行动或话语，你要接住它，让剧情自然往下走，不拒绝、不跳转、不替玩家做重大决定',
    '- 例外：如果玩家用（）把话括起来，或明显是在和你这个主持人说话（提问、闲聊、吐槽、要求调整设定或节奏），就跳出故事，以主持人的身份像朋友一样自然闲聊回复，不推进剧情、不输出【事件】【结局】行',
    '- 剧情要有松有紧：允许写平静的日常段落，不要每段都制造冲突和悬念',
    '- 【当前档案】是最高优先级事实：叙述必须与档案里的资金、状态、穿搭保持一致；玩家手动改过档案后，立刻按新档案写；剧情导致变化时才用【档案】行更新',
    '- 每段 120~220 字',
    '- 剧情完全自由：不预设剧情线、不在结尾给选项或走向引导、不替玩家规划路线，玩家做什么故事就往哪走；你只负责接住并写好后果',
    '',
    '【文风要求】',
    `- ${ANTI_AI_RULES}`,
    styleRules ? `- 语言风格：${styleRules}` : '',
    customRules ? `- 创作者自制插件规则（优先级高于一般文风要求，必须遵守）：${customRules}` : '',
    '',
    '【故事设定】',
    `- 题材：${setup.genre}`,
    `- 背景：${setup.background}`,
    `- 主角：${setup.heroName}，${setup.gender}${setup.age ? `，${setup.age}` : ''}，性格：${setup.personality}，长相：${setup.appearance}`,
    story.worldview ? '' : undefined,
    story.worldview ? '【世界观与人物前传】' : undefined,
    story.worldview ? story.worldview.slice(0, 900) : undefined,
    '',
    '【当前档案】',
    `- 资金：${state.funds}`,
    `- 状态：${state.status}`,
    `- 穿搭：${state.outfit}`,
    '',
    '【当前物品栏】',
    story.items && story.items.length > 0 ? story.items.join('、') : '（空空如也）',
    '',
    sys ? `【玩法面板 · ${sys.name}】` : undefined,
    sys ? sys.rules : undefined,
    sys
      ? `- 当前面板：${
          story.panel && Object.keys(story.panel).length > 0
            ? Object.entries(story.panel)
                .map(([k, v]) => `${k}：${v}`)
                .join('，')
            : '（开局第一段由你随机生成初始面板：天赋类随机 roll，数值类按规则计算初始值，身份平凡起步）'
        }`
      : undefined,
    sys ? '- 面板是硬规则：胜负、收支、数值增减都必须按面板规则结算，叙述不得与面板矛盾' : undefined,
    sys
      ? '- 道具与资产：面板里带数量的条目都是道具；玩家使用道具必须扣除一个并结算效果；玩家花钱买到的东西要转成对应资产写进面板相应字段（买房写进资产、买车买装备写进随身/装备栏），钱货两清从资金里扣；交易和使用允许有意外（被坑、临时加价、货不对板、效果浮动），偶尔发生即可，不要每次都发生意外'
      : undefined,
    sys
      ? '- 节奏偏爽文：每段都要有明确进展或爽点（变强、收获、打脸、反杀、机缘到手、谜团揭开），冲突快速见分晓，主角少吃瘪；语言直白爽快，【文风要求】里关于隐喻、留白、跳切的要求全部让位于爽感和进度'
      : undefined,
    sys ? '' : undefined,
    '【人物关系网】',
    relations,
    '',
    '【输出约定】',
    '- 剧情中若资金、状态或穿搭发生变化，在整段最后单独起一行输出：【档案】{"资金":"...","状态":"...","穿搭":"..."}（三项都要写全）；每段都要检查一遍，有变化就必须输出，没有变化才不输出',
    '- 剧情中若出现了新的有名有姓的人物，在整段最后单独起一行输出：【人物】[{"姓名":"...","关系":"与主角的关系","备注":"外貌或性格一句话"}]，一次可多个人物；无名无姓的路人不用输出',
    '- 关系网里已有的人物，若关系、状态或信息发生了变化（比如从陌生变成熟识、受了伤、身份揭晓），也要输出同名的【人物】条目，系统会自动更新档案，不要只写新人物',
    '- 剧情里出现手机聊天、发消息的场景时，在整段最后单独起一行输出：【聊天】{"标题":"与某某的聊天","消息":[{"from":"对方名字或主角名","text":"消息内容"}]}，按时间顺序还原真实对话；只在剧情真的涉及聊天时输出',
    '- 剧情走到终点（死亡、圆满收场等）时，输出【结局】{"方式":"结局类型","总结":"一句话概括结局"}',
    '- 每段剧情（闲聊除外）最后都要输出一行：【物品】["聚气丹×3","青锋剑"]，全量列出主角当前身上所有有实体的物品——剧情里捡到、买到、被赠的加进来，用掉、损毁、卖掉的去掉，多个用数量×N表示；一件都没有就输出【物品】[]',
    sys
      ? `- 每段剧情（闲聊除外）最后都要输出一行：【面板】{"字段":"值",...}，包含全部面板字段（${sys.fields.join('、')}）的当前值，值用简短字符串，列表类字段用「、」分隔；每段都要输出以便系统同步`
      : undefined,
    '- 【档案】【人物】【聊天】【事件】【结局】【面板】【物品】这些行都放在所有剧情文字之后，顺序任意',
    '- 除这几行外，不要输出任何 JSON、代码块或解释性文字；没有被要求时，不要主动输出【事件】和【结局】行',
  ]
    .filter((line): line is string => !!line)
    .join('\n')
}

/** 开场指令 */
export function openingPrompt(story: Story): string {
  const sys = storySystem(story)
  return [
    `故事开始。请写开场第一段：交代「${story.setup.background}」中的场景，让${story.setup.heroName}出场并处在一个可行动的处境里，把舞台交给玩家。`,
    sys
      ? '本故事启用了玩法系统：先随机生成初始面板（天赋类随机 roll，战力/资产类按规则计算初始值，身份从平凡起步），把初始面板写进【面板】行，开场剧情里自然带出主角的起点处境。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* ---------------- 突发事件与生死危机 ---------------- */

/** 高危题材：突发事件更频繁，且更可能危及生命 */
const DANGER_RE = /武侠|古风|江湖|悬疑|推理|末日|战争|修仙|谍战|惊悚|凶杀|盗墓|求生/

export function isDangerGenre(genre: string): boolean {
  return DANGER_RE.test(genre)
}

/** 本轮是否触发突发事件（前端控概率，结果写进特别指令） */
export function rollEvent(genre: string): { trigger: boolean; crisis: boolean } {
  const danger = isDangerGenre(genre)
  const trigger = Math.random() < (danger ? 0.38 : 0.22)
  if (!trigger) return { trigger: false, crisis: false }
  const crisis = Math.random() < (danger ? 0.5 : 0.25)
  return { trigger: true, crisis }
}

/** 突发事件指令（作为额外 system 消息追加到本轮） */
export function eventDirective(crisis: boolean): string {
  return [
    '【本轮特别指令】承接玩家行动推进剧情时，自然插入一个突发事件（意外变故 / 不速之客 / 关键发现），可借此引出有名有姓的新人物，事件要贴着当前剧情走，不突兀。',
    crisis
      ? '本次事件必须危及生命（刺杀、坠崖、中毒、真凶现身、天灾这类），让玩家下一步应对决定生死。'
      : '本次事件不危及生命，用来制造波澜、推动剧情或引出新人物。',
    '事件写完后，在所有剧情文字之后输出【事件】{"简介":"一句话概括","危机":' + (crisis ? 'true' : 'false') + '}。',
  ].join('')
}

/** 危机评判指令：主角身处危机时，评判玩家应对是否合理 */
export function crisisJudgeDirective(crisis: string): string {
  return [
    `【危机评判】主角正身处危机：${crisis}。`,
    '评判玩家本轮的应对是否合理：合理→写出化解过程，危机解除，剧情继续；敷衍、作死或明显不合理→写出主角的死亡结局（120~220字，遵守文风规则），并在最后输出【结局】{"方式":"死亡","总结":"一句话概括结局"}。',
    '无论化解还是死亡，之后都不再重复本次危机。',
  ].join('')
}

/* ---------------- 道具使用 ---------------- */

/** 各玩法系统里的「道具栏」字段名：这些字段的值会被解析成可点用的道具 */
export const USABLE_FIELDS: Record<string, string[]> = {
  xiuxian: ['丹药法宝'],
  wuxia: ['兵器', '武功绝学'],
  urban: ['随身物品'],
  mystery: ['随身道具'],
  fantasy: ['装备'],
  apocalypse: ['物资', '武器'],
  campus: [],
}

export type PanelItem = { name: string; count: number }

/** 从道具栏字符串解析道具列表：兼容「聚气丹×3、疗伤丹、飞剑x2、符箓（5）」等写法 */
export function parseItems(raw: string): PanelItem[] {
  return raw
    .split(/[、,，;；/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let m = s.match(/^(.*?)\s*[×xX*]\s*(\d+)$/)
      if (m) return { name: m[1].trim(), count: parseInt(m[2], 10) }
      m = s.match(/^(.*?)[（(]\s*(\d+)\s*[)）]$/)
      if (m) return { name: m[1].trim(), count: parseInt(m[2], 10) }
      return { name: s, count: 1 }
    })
    .filter((it) => it.name.length > 0 && it.name.length <= 12 && !/^(无|暂无|没有|空)/.test(it.name))
}

export type ItemOutcome = 'success' | 'partial' | 'backfire'

/** 道具使用判定（前端 roll）：70% 成功 / 20% 效果打折 / 10% 反噬 */
export function rollItemOutcome(): ItemOutcome {
  const r = Math.random()
  if (r < 0.7) return 'success'
  if (r < 0.9) return 'partial'
  return 'backfire'
}

export const OUTCOME_LABEL: Record<ItemOutcome, string> = {
  success: '使用成功',
  partial: '效果打折',
  backfire: '遭到反噬',
}

/** 道具使用指令（作为额外 system 消息追加到本轮）：判定结果前端已定，AI 照写并结算 */
export function itemUseDirective(itemName: string, outcome: ItemOutcome): string {
  const verdict =
    outcome === 'success'
      ? '判定结果：使用成功，效果全额发挥（修为/战力/恢复/资产等按面板规则结算，可以略有惊喜浮动）'
      : outcome === 'partial'
        ? '判定结果：效果打折，只有约一半功效，写出打折的具体原因（品质不纯、仓促使用、时机不对等）'
        : '判定结果：使用反噬——道具没发挥作用还带来代价（受伤、状态变差、损失资金、道具损毁等，按题材合理选择），反噬不直接致死'
  return [
    `【本轮特别指令】玩家主动使用了道具「${itemName}」。${verdict}。`,
    '在剧情里写出使用的过程和结果，并在【物品】行中把该道具数量减 1（减到 0 就移除）、有玩法面板时在【面板】行同步扣减，同时结算效果带来的变化；资金、状态、穿搭有变化时照常输出【档案】行。',
    '本轮照常推进剧情，不要因为使用道具而停下故事。',
  ].join('')
}

/** 完结评判指令：给整个故事打幸福指数和精彩程度 */
export function evaluationPrompt(story: Story): string {
  const history = story.msgs
    .slice(-40)
    .map((m) => `${m.role === 'user' ? '玩家' : '叙述'}：${m.content.slice(0, 260)}`)
    .join('\n')
  return [
    '故事完结了。请你作为评委，通读下面的设定和故事过程，给出综合评价。',
    '只输出一行：【评分】{"幸福指数":0到100的整数,"精彩程度":0到100的整数,"评语":"60~120字的总评，说人话，点出最亮眼和最可惜的地方"}',
    '幸福指数看主角最终的境遇与情感归宿；精彩程度看剧情张力、反转和文笔。',
    '除此一行外不要输出任何其他内容。',
    '',
    `【题材】${story.setup.genre} 【主角】${story.setup.heroName} 【完结方式】${story.endingType ?? '手动完结'}`,
    story.worldview ? `【世界观】${story.worldview.slice(0, 400)}` : '',
    '【故事过程】',
    history,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 从评分回复里解析【评分】 */
export function parseScore(reply: string): StoryScore | null {
  const m = reply.match(/【评分】\s*(\{[\s\S]*?\})/)
  if (!m) return null
  try {
    const o = JSON.parse(m[1]) as { 幸福指数?: number; 精彩程度?: number; 评语?: string }
    if (typeof o.幸福指数 !== 'number' || typeof o.精彩程度 !== 'number') return null
    return {
      happiness: Math.max(0, Math.min(100, Math.round(o.幸福指数))),
      brilliance: Math.max(0, Math.min(100, Math.round(o.精彩程度))),
      comment: (o.评语 ?? '').trim(),
    }
  } catch {
    return null
  }
}

/** 世界观与人物前传的生成指令 */
export function worldviewPrompt(story: Story): string {
  const { setup } = story
  return [
    '基于以上设定，为这个故事写一份「世界观与人物前传」，300~450 字，要求：',
    `1. 补全世界观：把「${setup.background}」扩展成一个可信的世界——时代气息、地点细节、这个世界的规则或氛围`,
    `2. 补齐主角前传：${setup.heroName}在故事开始前的人生${setup.age ? `（今年${setup.age}，把这些年的成长线串起来）` : ''}，写两三件塑造了 TA 性格的关键小事，让 TA 立体起来`,
    '3. 埋下两个可以在后续剧情中回收的伏笔，但不要点破',
    '只写连贯的叙述文字，分两到三段，不要列表、不要标题、不要评论',
  ].join('\n')
}

/** 从回复（含流式半截文本）里提取【面板】；JSON 没闭合或没有面板时返回 undefined */
export function extractPanel(reply: string): Record<string, string> | undefined {
  const m = reply.match(/【面板】\s*(\{[\s\S]*?\})/)
  if (!m) return undefined
  try {
    const o = JSON.parse(m[1]) as Record<string, unknown>
    const p: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' || typeof v === 'number') p[k] = String(v)
    }
    return Object.keys(p).length > 0 ? p : undefined
  } catch {
    return undefined
  }
}

/** 从 AI 回复里剥离【档案】【人物】【事件】【结局】行 */
export function parseReply(
  reply: string,
  prev: StoryState,
): {
  text: string
  state: StoryState
  newChars: { name: string; relation: string; note: string }[]
  event?: { summary: string; crisis: boolean }
  ending?: { type: string; summary: string }
  chat?: ChatCard
  panel?: Record<string, string>
  items?: string[]
} {
  let state = prev
  let newChars: { name: string; relation: string; note: string }[] = []
  let event: { summary: string; crisis: boolean } | undefined
  let ending: { type: string; summary: string } | undefined

  const archiveMatch = reply.match(/【档案】\s*(\{[\s\S]*?\})/)
  if (archiveMatch) {
    try {
      const obj = JSON.parse(archiveMatch[1]) as Partial<Record<'资金' | '状态' | '穿搭', string>>
      state = {
        funds: typeof obj.资金 === 'string' ? obj.资金 : prev.funds,
        status: typeof obj.状态 === 'string' ? obj.状态 : prev.status,
        outfit: typeof obj.穿搭 === 'string' ? obj.穿搭 : prev.outfit,
      }
    } catch {
      // 解析失败就忽略，不影响剧情
    }
  }

  const charsMatch = reply.match(/【人物】\s*(\[[\s\S]*?\])/)
  if (charsMatch) {
    try {
      const arr = JSON.parse(charsMatch[1]) as { 姓名?: string; 关系?: string; 备注?: string }[]
      newChars = arr
        .filter((c) => typeof c.姓名 === 'string' && c.姓名.trim())
        .map((c) => ({
          name: c.姓名!.trim(),
          relation: (c.关系 ?? '').trim() || '剧情人物',
          note: (c.备注 ?? '').trim(),
        }))
    } catch {
      // 解析失败就忽略
    }
  }

  const eventMatch = reply.match(/【事件】\s*(\{[\s\S]*?\})/)
  if (eventMatch) {
    try {
      const o = JSON.parse(eventMatch[1]) as { 简介?: string; 危机?: boolean }
      event = { summary: (o.简介 ?? '').trim(), crisis: o.危机 === true }
    } catch {
      // 忽略
    }
  }

  const endingMatch = reply.match(/【结局】\s*(\{[\s\S]*?\})/)
  if (endingMatch) {
    try {
      const o = JSON.parse(endingMatch[1]) as { 方式?: string; 总结?: string }
      ending = { type: (o.方式 ?? '死亡').trim(), summary: (o.总结 ?? '').trim() }
    } catch {
      // 忽略
    }
  }

  let chat: ChatCard | undefined
  const chatMatch = reply.match(/【聊天】\s*(\{[\s\S]*?\})\s*(?=【|$)/)
  if (chatMatch) {
    try {
      const o = JSON.parse(chatMatch[1]) as { 标题?: string; 消息?: { from?: string; text?: string }[] }
      const messages = (o.消息 ?? [])
        .filter((m) => typeof m.from === 'string' && typeof m.text === 'string')
        .map((m) => ({ from: m.from!.trim(), text: m.text! }))
      if (messages.length > 0) chat = { title: (o.标题 ?? '聊天记录').trim(), messages }
    } catch {
      // 忽略
    }
  }

  const text = reply
    .replace(/【(档案|人物|聊天|事件|结局|面板|物品)】[\s\S]*?(?=【(?:档案|人物|聊天|事件|结局|面板|物品)】|$)/g, '')
    .trim()

  const panel = extractPanel(reply)

  let items: string[] | undefined
  const itemsMatch = reply.match(/【物品】\s*(\[[\s\S]*?\])/)
  if (itemsMatch) {
    try {
      const arr = JSON.parse(itemsMatch[1]) as unknown[]
      items = arr
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 40)
    } catch {
      // 解析失败就忽略，沿用旧物品栏
    }
  }

  return { text, state, newChars, event, ending, chat, panel, items }
}
