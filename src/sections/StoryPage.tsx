import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Check,
  Coins,
  Eye,
  EyeOff,
  Flag,
  Gamepad2,
  ImagePlus,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Shirt,
  Skull,
  Sparkles,
  Trash2,
  Trophy,
  UserRound,
  UsersRound,
  Wallet,
  X,
} from 'lucide-react'
import type { User } from './LoginPage'
import { bothReady, chatCompletion, chatStream, clearApiKey, fetchBalance, generateImage, getApiKey, getDoubaoUsage, getGeminiModel, getProvider, isImageReady, isReady, otherReady, setApiKey, setDoubaoEndpoint, setGeminiBaseUrl, setGeminiModel, setImageEndpoint, setProvider, type BalanceInfo, type ChatMessage, type DoubaoUsage, type Provider } from '../lib/deepseek'
import {
  STYLE_PLUGINS,
  OUTCOME_LABEL,
  USABLE_FIELDS,
  addPlugin,
  buildSystemPrompt,
  crisisJudgeDirective,
  deleteStory,
  detectGenreSystem,
  editPlugin,
  evaluationPrompt,
  eventDirective,
  extractPanel,
  itemUseDirective,
  loadPlugins,
  loadStories,
  openingPrompt,
  parseItems,
  parseReply,
  parseScore,
  removePlugin,
  rollEvent,
  rollItemOutcome,
  storySystem,
  upsertStory,
  worldviewPrompt,
  type Relation,
  type Story,
  type StorySetup,
  type WritingPlugin,
} from '../lib/story'
import { publishBook, subscribeBoard, type BoardBook } from '../lib/storyBoard'

type View = 'list' | 'setup' | 'wvreview' | 'game' | 'board'

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** 合并剧情人物：新人物入库；同名人物有新信息时更新关系/备注（关系网随剧情成长） */
function mergeNewChars(
  relations: Relation[],
  heroName: string,
  chars: { name: string; relation: string; note: string }[],
): { relations: Relation[]; added: string[]; updated: string[] } {
  const added: string[] = []
  const updated: string[] = []
  const merged = [...relations]
  for (const c of chars) {
    const name = c.name.trim()
    if (!name || name === heroName) continue
    const idx = merged.findIndex((r) => r.name === name)
    if (idx < 0) {
      merged.push({ id: uid(), name, relation: c.relation, note: c.note })
      added.push(name)
    } else {
      const old = merged[idx]
      const next = {
        ...old,
        relation: c.relation && c.relation !== '剧情人物' ? c.relation : old.relation,
        note: c.note ? (old.note ? `${old.note}；${c.note}` : c.note) : old.note,
      }
      if (next.relation !== old.relation || next.note !== old.note) {
        merged[idx] = next
        updated.push(name)
      }
    }
  }
  return { relations: merged, added, updated }
}

/** 把 AI 段落结尾的「→」引导行拆成可点选项（支持「A.…；B.…；C.…」格式） */
function splitGuidance(text: string): { body: string; options: string[] } {
  const m = text.match(/(^|\n)\s*→\s*(.+)$/)
  if (!m) return { body: text, options: [] }
  const line = m[2]
  const options = (/[；;]/.test(line) ? line.split(/[；;]/) : line.split('、'))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
  return { body: text.slice(0, m.index).trim(), options }
}

/** 流式展示用：隐藏协议块和没传完的半截标记 */
function streamPreview(text: string): string {
  return text
    .replace(/【(档案|人物|事件|结局|聊天|面板|物品)】[\s\S]*$/s, '')
    .replace(/【[^】]*$/s, '')
    .trimEnd()
}

/** 主角形象图：单独存 localStorage（dataURL 较大，不塞进故事 JSON） */
const portraitKey = (id: string) => `story-portrait-${id}`
function loadPortrait(id: string): string {
  try {
    return localStorage.getItem(portraitKey(id)) ?? ''
  } catch {
    return ''
  }
}
function savePortrait(id: string, dataUrl: string): boolean {
  try {
    localStorage.setItem(portraitKey(id), dataUrl)
    return true
  } catch {
    return false // 超容量就只留在本次会话，不阻塞生图
  }
}

/** 形象图默认提示词：按开局设定和当前穿搭自动拼，弹窗里可改 */
function portraitPromptOf(s: Story): string {
  const { setup, state } = s
  return [
    '精美人物立绘，柔和光影，干净简洁的背景，高质量插画',
    `人物：${setup.heroName}，${setup.gender}${setup.age ? `，${setup.age}` : ''}`,
    setup.appearance ? `长相：${setup.appearance}` : '',
    `穿搭：${state.outfit}`,
    `题材氛围：${setup.genre}，${setup.background}`,
  ]
    .filter(Boolean)
    .join('。')
}

const SUGGEST = {
  genre: ['修仙', '武侠江湖', '现代都市', '悬疑推理', '奇幻异世界', '末日求生', '青春校园'],
  gender: ['女', '男', '其他'],
  personality: ['外冷内热', '开朗跳脱', '温柔细腻', '毒舌但心软', '沉稳可靠'],
  appearance: ['黑发及腰，笑起来有梨涡', '短发利落，眼神很亮', '戴眼镜，气质干净', '高挑清瘦，眉眼冷淡'],
  background: ['江南水乡的小镇，梅雨季节', '繁华都市的深夜', '山海之间的孤城', '武林动荡的年代'],
}

const EMPTY_SETUP: StorySetup = {
  heroName: '',
  gender: '女',
  age: '',
  personality: '',
  appearance: '',
  genre: '',
  background: '',
  outfit: '',
  funds: '1000 金币',
  styles: [],
}

/** 双 AI 协作：另一家负责润色正文（不动设定和协议块） */
const POLISH_SYS =
  '你是中文小说编辑。把用户给的剧情段落润色一遍：保持第三人称、事实和长度（120~220字），让文字更生动自然、更有画面感；' +
  '不要新增设定和人物，不要输出任何解释、标签或 JSON，只输出润色后的正文。'

const COLLAB_KEY = 'story-collab'

const PROVIDER_NAME: Record<Provider, string> = { deepseek: 'DeepSeek', doubao: '豆包', gemini: 'Gemini' }

/** 世界观后台生成任务：退出本页也继续跑，回来后自动接上 */
type BgGen = {
  story: Story
  text: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
}
let bgGen: BgGen | null = null

export default function StoryPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [view, setView] = useState<View>('list')
  const [stories, setStories] = useState<Story[]>(() => loadStories(user.name))
  const [current, setCurrent] = useState<Story | null>(null)

  /* ---- AI 接入 & 余额 ---- */
  const [provider, setProviderState] = useState<Provider>(getProvider())
  const [aiReady, setAiReady] = useState(isReady())
  const [keyInput, setKeyInput] = useState('')
  const [epInput, setEpInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyMsg, setKeyMsg] = useState('')
  const [balance, setBalance] = useState<BalanceInfo | null>(null)
  const [balanceErr, setBalanceErr] = useState('')
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [dbUsage, setDbUsage] = useState<DoubaoUsage>(getDoubaoUsage())
  const [collab, setCollab] = useState(localStorage.getItem(COLLAB_KEY) === '1')
  // 新故事的写作渠道：双AI协作 / DeepSeek 独写 / 豆包独写 / Gemini 独写
  const [channel, setChannel] = useState<'collab' | 'deepseek' | 'doubao' | 'gemini'>('collab')
  // Gemini 可选配置：模型名与接口地址（留空用默认）
  const [geminiModelInput, setGeminiModelInput] = useState('')
  const [geminiBaseInput, setGeminiBaseInput] = useState('')

  /* ---- 写作插件：自制规则，开局勾选调用 ---- */
  const [myPlugins, setMyPlugins] = useState<WritingPlugin[]>(() => loadPlugins(user.name))
  const [pluginModal, setPluginModal] = useState<null | { id?: string }>(null)
  const [pluginName, setPluginName] = useState('')
  const [pluginRule, setPluginRule] = useState('')

  const openPluginModal = (p?: WritingPlugin) => {
    setPluginName(p?.name ?? '')
    setPluginRule(p?.rule ?? '')
    setPluginModal({ id: p?.id })
  }

  const savePlugin = () => {
    const name = pluginName.trim()
    const rule = pluginRule.trim()
    if (!name || !rule) return
    setMyPlugins(
      pluginModal?.id
        ? editPlugin(user.name, pluginModal.id, name, rule)
        : addPlugin(user.name, name, rule),
    )
    setPluginModal(null)
  }

  const togglePlugin = (id: string) => {
    const cur = setup.pluginIds ?? []
    const pluginIds = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    setSetup({ ...setup, pluginIds })
  }

  /* ---- 生图模式（豆包 Seedream） ---- */
  const [imgEpInput, setImgEpInput] = useState('')
  const [imgReady, setImgReady] = useState(isImageReady())
  const [portraitOpen, setPortraitOpen] = useState(false)
  const [portraitImg, setPortraitImg] = useState('')
  const [portraitPrompt, setPortraitPrompt] = useState('')
  const [portraitBusy, setPortraitBusy] = useState(false)
  const [portraitErr, setPortraitErr] = useState('')

  // 云端恢复监听：换浏览器/换设备登录时，存档从云端落回本地后重读刷新界面
  useEffect(() => {
    const onKv = (e: Event) => {
      const key = (e as CustomEvent<{ key: string }>).detail?.key
      if (key === `story-books-${user.name}`) setStories(loadStories(user.name))
      else if (key === `story-plugins-${user.name}`) setMyPlugins(loadPlugins(user.name))
    }
    window.addEventListener('lovesite-kv-applied', onKv)
    return () => window.removeEventListener('lovesite-kv-applied', onKv)
  }, [user.name])

  const toggleCollab = () => {
    const next = !collab
    setCollab(next)
    localStorage.setItem(COLLAB_KEY, next ? '1' : '0')
  }

  /** 双 AI 协作：当前模型主写，另一家已配好的润色正文 */
  const polishByOther = async (text: string): Promise<string> => {
    if (!collab) return text
    const other = otherReady(provider)
    if (!other) return text
    setPolishing(true)
    try {
      const polished = await chatCompletion(
        [
          { role: 'system', content: POLISH_SYS },
          { role: 'user', content: text },
        ],
        other,
      )
      setDbUsage(getDoubaoUsage())
      return polished
    } catch {
      return text // 润色失败就用原稿，不阻塞剧情
    } finally {
      setPolishing(false)
    }
  }

  /** 故事的写作渠道：独写模式固定走对应 AI，协作模式走当前选中的主写 */
  const providerOf = (s: Story): Provider =>
    s.channel === 'deepseek' || s.channel === 'doubao' || s.channel === 'gemini' ? s.channel : provider

  /** 渠道感知润色：独写渠道跳过另一家润色，出稿直接更快 */
  const polishFor = (s: Story, text: string): Promise<string> =>
    s.channel && s.channel !== 'collab' ? Promise.resolve(text) : polishByOther(text)

  const switchProvider = (p: Provider) => {
    setProvider(p)
    setProviderState(p)
    setAiReady(isReady(p))
    setKeyMsg('')
  }

  const refreshBalance = async () => {
    setBalanceLoading(true)
    setBalanceErr('')
    try {
      setBalance(await fetchBalance())
    } catch (e) {
      setBalance(null)
      setBalanceErr(e instanceof Error ? e.message : '查询失败')
    } finally {
      setBalanceLoading(false)
    }
  }
  useEffect(() => {
    if (provider === 'deepseek' && getApiKey('deepseek')) void refreshBalance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  /* ---- 开局引导 ---- */
  const [setup, setSetup] = useState<StorySetup>(EMPTY_SETUP)
  const [starting, setStarting] = useState(false)
  const [startErr, setStartErr] = useState('')
  const [draft, setDraft] = useState<Story | null>(null) // 世界观待确认的草稿
  const [wvDraft, setWvDraft] = useState('') // 可编辑的世界观文本

  /* ---- 游戏中 ---- */
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [chatErr, setChatErr] = useState('')
  const [failedBase, setFailedBase] = useState<Story | null>(null) // 生成失败时的故事状态，用于一键重试
  const [relOpen, setRelOpen] = useState(false)
  const [relDraft, setRelDraft] = useState<Relation | null>(null)
  const [stateEdit, setStateEdit] = useState(false)
  const [stateDraft, setStateDraft] = useState({ funds: '', status: '', outfit: '' })
  const [charNotice, setCharNotice] = useState('')
  const [panelOpen, setPanelOpen] = useState(false) // 玩法面板默认折叠在左下角，点开才展开
  const [wvOpen, setWvOpen] = useState(false)
  const [startStep, setStartStep] = useState('')
  const [streamText, setStreamText] = useState('') // 流式生成的实时文本（逐字显示）
  const [livePanel, setLivePanel] = useState<Record<string, string> | null>(null) // 流式途中实时解析出的面板
  const [polishing, setPolishing] = useState(false) // 双 AI 协作：另一家润色中
  /* ---- 突发事件 / 完结 / 榜单 ---- */
  const [eventNotice, setEventNotice] = useState<{ text: string; crisis: boolean } | null>(null)
  const [endConfirm, setEndConfirm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Story | null>(null)
  const [bookName, setBookName] = useState('')
  const [scoring, setScoring] = useState(false)
  const [board, setBoard] = useState<BoardBook[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: streamText ? 'auto' : 'smooth' })
  }, [current?.msgs.length, sending, streamText])

  // 新人物提示 3.5 秒后自动消失
  useEffect(() => {
    if (!charNotice) return
    const t = setTimeout(() => setCharNotice(''), 3500)
    return () => clearTimeout(t)
  }, [charNotice])

  const persist = (story: Story) => {
    setStories(upsertStory(user.name, story))
    setCurrent({ ...story })
  }

  // 接管后台世界观生成：上次退出页面时还在跑/已跑完的任务，回来自动接上
  useEffect(() => {
    if (!bgGen) return
    const g = bgGen
    if (g.status === 'running') {
      setSetup(g.story.setup)
      setStarting(true)
      setStartStep('正在构建世界观…')
      setStreamText(g.text)
      setView('setup')
      const t = setInterval(() => {
        if (!bgGen || bgGen.story.id !== g.story.id) {
          clearInterval(t)
          return
        }
        if (bgGen.status === 'running') {
          setStreamText(bgGen.text)
          return
        }
        clearInterval(t)
        const done = bgGen.status === 'done'
        const result = bgGen.result ?? ''
        const err = bgGen.error ?? '生成失败，再试一次'
        const story = bgGen.story
        bgGen = null
        setStarting(false)
        setStartStep('')
        setStreamText('')
        setSetup(story.setup)
        if (done) {
          setDraft(story)
          setWvDraft(result)
          setView('wvreview')
        } else {
          setView('setup')
          setStartErr(err)
        }
      }, 400)
      return () => clearInterval(t)
    }
    bgGen = null
    setSetup(g.story.setup)
    if (g.status === 'done') {
      setDraft(g.story)
      setWvDraft(g.result ?? '')
      setView('wvreview')
    } else {
      setView('setup')
      setStartErr(g.error ?? '生成失败，再试一次')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---- 开始新故事：先生成世界观给你过目（后台任务，退出页面也继续跑） ---- */
  const genWorldview = async () => {
    setStartErr('')
    setStarting(true)
    const story: Story = {
      id: uid(),
      title: `${setup.genre} · ${setup.heroName}`,
      setup: { ...setup, plugins: myPlugins.filter((p) => (setup.pluginIds ?? []).includes(p.id)) },
      worldview: '',
      system: detectGenreSystem(`${setup.genre} ${setup.background}`)?.id,
      channel,
      state: { funds: setup.funds, status: '状态良好', outfit: setup.outfit || '日常便服' },
      relations: [],
      msgs: [],
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    bgGen = { story, text: '', status: 'running' }
    try {
      setStartStep('正在构建世界观…')
      setStreamText('')
      const worldview = await chatStream(
        [
          { role: 'system', content: buildSystemPrompt(story) },
          { role: 'user', content: worldviewPrompt(story) },
        ],
        (t) => {
          if (bgGen?.story.id === story.id) bgGen.text = t
          setStreamText(t)
        },
        providerOf(story),
      )
      if (bgGen?.story.id === story.id) {
        bgGen.status = 'done'
        bgGen.result = worldview.trim()
      }
      setDraft(story)
      setWvDraft(worldview.trim())
      // 还停在开局页就直接跳确认页；去了别处由列表卡片/挂载接管
      setView((v) => {
        if (v === 'setup' || v === 'wvreview') {
          if (bgGen?.story.id === story.id) bgGen = null
          return 'wvreview'
        }
        return v
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败，再试一次'
      if (bgGen?.story.id === story.id) {
        bgGen.status = 'error'
        bgGen.error = msg
      }
      setStartErr(msg)
    } finally {
      setStarting(false)
      setStartStep('')
      setStreamText('')
    }
  }

  /* ---- 世界观确认后：写开场，正式开局 ---- */
  const confirmStart = async () => {
    if (!draft) return
    setStartErr('')
    setStarting(true)
    const story: Story = { ...draft, worldview: wvDraft.trim() }
    try {
      setStartStep('正在生成开场…')
      setStreamText('')
      const reply = await chatStream(
        [
          { role: 'system', content: buildSystemPrompt(story) },
          { role: 'user', content: openingPrompt(story) },
        ],
        (t) => setStreamText(t),
        providerOf(story),
      )
      setStreamText('')
      const { text, state, newChars, chat, panel, items } = parseReply(reply, story.state)
      const merged = mergeNewChars(story.relations, story.setup.heroName, newChars)
      const seg = await polishFor(story, text)
      story.state = state
      if (panel) story.panel = panel
      if (items) story.items = items
      story.relations = merged.relations
      story.msgs = [{ role: 'assistant', content: seg, chat, ts: Date.now() }]
      persist(story)
      if (merged.added.length > 0) setCharNotice(`新人物 ${merged.added.join('、')} 已加入关系网`)
      setView('game')
      setSetup(EMPTY_SETUP)
      setDraft(null)
      setWvDraft('')
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : '开场失败，再试一次')
    } finally {
      setStarting(false)
      setStartStep('')
      setStreamText('')
    }
  }

  // 事件提示 4 秒后自动消失
  useEffect(() => {
    if (!eventNotice) return
    const t = setTimeout(() => setEventNotice(null), 4000)
    return () => clearTimeout(t)
  }, [eventNotice])

  // 榜单订阅
  useEffect(() => subscribeBoard((b) => setBoard(b)), [])

  /* ---- 剧情推进（含突发事件与危机评判） ---- */
  const act = async (action: string) => {
    if (!current || sending || current.ended) return
    const text = action.trim()
    if (!text) return
    const withMine: Story = { ...current, msgs: [...current.msgs, { role: 'user', content: text, ts: Date.now() }] }
    setCurrent(withMine)
    setInput('')
    await generate(withMine)
  }

  /** 点「用」把道具投进聊天框：保留已输入的文字，发送即生效（判定结果发送时才掷） */
  const useItem = (name: string) => {
    if (sending || !current || current.ended) return
    setInput((prev) => (prev.includes('【使用道具：') ? prev : `【使用道具：${name}】${prev ? ' ' + prev : ''}`))
  }

  /* ---- 主角形象图（豆包 Seedream） ---- */
  const openPortrait = () => {
    if (!current) return
    setPortraitImg(loadPortrait(current.id))
    setPortraitPrompt(portraitPromptOf(current))
    setPortraitErr('')
    setPortraitOpen(true)
  }

  const doGeneratePortrait = async () => {
    if (!current || portraitBusy) return
    if (!imgReady) {
      setPortraitErr('先到密钥配置里填入图像模型的接入点 ID（ep- 开头）')
      return
    }
    const prompt = portraitPrompt.trim()
    if (!prompt) return
    setPortraitBusy(true)
    setPortraitErr('')
    try {
      const dataUrl = await generateImage(prompt, '1024x1024')
      setPortraitImg(dataUrl)
      savePortrait(current.id, dataUrl)
    } catch (e) {
      setPortraitErr(e instanceof Error ? e.message : '生图失败，再试一次')
    } finally {
      setPortraitBusy(false)
    }
  }

  /** 核心生成流程：从给定故事状态续写一段；失败后可一键重试，不会重复追加玩家消息 */
  const generate = async (withMine: Story) => {
    setChatErr('')
    setFailedBase(null)
    setSending(true)
    try {
      const extras: ChatMessage[] = []
      const playerText = withMine.msgs[withMine.msgs.length - 1]?.content ?? ''
      const ooc = /^[（(]/.test(playerText) // 括号开头 = 和主持人闲聊，不推剧情不掷事件
      if (!ooc) {
        if (withMine.pendingCrisis) {
          // 身处危机：评判本轮应对是否足以化解
          extras.push({ role: 'system', content: crisisJudgeDirective(withMine.pendingCrisis) })
        } else {
          // 安全期：按概率掷一个突发事件
          const roll = rollEvent(withMine.setup.genre)
          if (roll.trigger) extras.push({ role: 'system', content: eventDirective(roll.crisis) })
        }
        // 道具使用：消息带【使用道具：X】时，前端先 roll 判定（成功/打折/反噬），指令 AI 照写并扣道具
        const itemMatch = playerText.match(/【使用道具[:：]([^】]+)】/)
        if (itemMatch) {
          const itemName = itemMatch[1].trim()
          const outcome = rollItemOutcome()
          extras.push({ role: 'system', content: itemUseDirective(itemName, outcome) })
          setEventNotice({ text: `使用「${itemName}」：${OUTCOME_LABEL[outcome]}`, crisis: outcome === 'backfire' })
        }
      }
      const ctx: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(withMine) },
        ...extras,
        ...withMine.msgs.slice(-10).map(({ role, content }) => ({ role, content })),
      ]
      setStreamText('')
      setLivePanel(null)
      const reply = await chatStream(
        ctx,
        (t) => {
          setStreamText(t)
          // 流式途中实时解析面板：AI 边写，面板边更新
          const p = extractPanel(t)
          if (p) setLivePanel(p)
        },
        providerOf(withMine),
      )
      // 注意：这里不清 streamText，让润色阶段原文保持可见，不让人干等
      const { text: seg, state, newChars, event, ending, chat, panel, items } = parseReply(reply, withMine.state)
      const polished = await polishFor(withMine, seg)
      const merged = mergeNewChars(withMine.relations, withMine.setup.heroName, newChars)
      if (merged.added.length > 0) setCharNotice(`新人物 ${merged.added.join('、')} 已加入关系网`)
      if (merged.updated.length > 0) setCharNotice(`关系网更新：${merged.updated.join('、')}`)

      let pendingCrisis = withMine.pendingCrisis
      if (event) {
        setEventNotice({ text: event.summary || '突发事件！', crisis: event.crisis })
        pendingCrisis = event.crisis ? event.summary || '命悬一线' : undefined
      } else if (pendingCrisis) {
        // 没有新事件说明危机已化解
        pendingCrisis = undefined
      }
      const ended = ending ? true : withMine.ended
      const endingType = ending ? ending.type : withMine.endingType

      persist({
        ...withMine,
        state,
        panel: panel ?? withMine.panel,
        items: items ?? withMine.items,
        relations: merged.relations,
        pendingCrisis,
        ended,
        endingType,
        msgs: [...withMine.msgs, { role: 'assistant', content: polished, chat, ts: Date.now() }],
      })
    } catch (e) {
      setChatErr(e instanceof Error ? e.message : '发送失败')
      setFailedBase(withMine)
    } finally {
      setSending(false)
      setStreamText('')
      setLivePanel(null)
    }
  }

  /* ---- 手动完结 ---- */
  const endStory = () => {
    if (!current) return
    persist({ ...current, ended: true, endingType: '手动完结', pendingCrisis: undefined })
    setEndConfirm(false)
    setBookName(current.bookName ?? '')
  }

  /* ---- DeepSeek 完结评分 ---- */
  const scoreStory = async () => {
    if (!current || scoring) return
    setScoring(true)
    try {
      const reply = await chatCompletion([
        { role: 'system', content: '你是一位资深文学评委，打分严格但公道。' },
        { role: 'user', content: evaluationPrompt(current) },
      ])
      const score = parseScore(reply)
      if (!score) throw new Error('评分格式异常，再试一次')
      persist({ ...current, score })
    } catch (e) {
      setChatErr(e instanceof Error ? e.message : '评分失败，再试一次')
    } finally {
      setScoring(false)
    }
  }

  /* ---- 上传榜单 ---- */
  const uploadBook = () => {
    if (!current || !current.score || !bookName.trim()) return
    publishBook({
      id: current.id,
      bookName: bookName.trim(),
      author: user.name,
      genre: current.setup.genre,
      endingType: current.endingType ?? '手动完结',
      happiness: current.score.happiness,
      brilliance: current.score.brilliance,
      comment: current.score.comment,
      endedTs: Date.now(),
    })
    persist({ ...current, bookName: bookName.trim(), uploaded: true })
  }

  /* ================= 视图：故事列表 ================= */
  if (view === 'list') {
    return (
      <div className="flex min-h-dvh flex-col bg-gradient-to-b from-[#fdf1f6] to-[#f9e4ef]">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
          <button onClick={onBack} className="rounded-full p-1.5 text-[#c44d7d] active:bg-pink-100">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <BookOpen className="h-5 w-5 text-[#c44d7d]" />
          <p className="text-base font-bold text-[#c44d7d]">剧情工坊</p>
          <span className="ml-auto text-[10px] text-pink-300">{PROVIDER_NAME[provider]} 驱动</span>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-8">
          {/* 余额卡片（DeepSeek 可见；豆包账单在火山引擎控制台） */}
          {provider === 'deepseek' ? (
            <div className="rounded-2xl bg-gradient-to-br from-[#4a3b6b] to-[#6b4a8a] p-4 text-white shadow-lg shadow-purple-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-amber-300" />
                  <p className="text-xs tracking-widest text-purple-200">DeepSeek 账户余额</p>
                </div>
                {getApiKey('deepseek') && (
                  <button onClick={() => void refreshBalance()} disabled={balanceLoading} className="rounded-full bg-white/15 p-1.5 active:scale-90">
                    {balanceLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              {!getApiKey('deepseek') ? (
                <p className="mt-3 text-sm text-purple-200/80">先在下面填入密钥，就能看到余额啦</p>
              ) : balance ? (
                <div className="mt-2">
                  <p className="text-3xl font-bold">¥ {balance.total}<span className="ml-1 text-xs font-normal text-purple-200">{balance.currency}</span></p>
                  <div className="mt-1.5 flex gap-4 text-[11px] text-purple-200/85">
                    <span>充值 ¥{balance.toppedUp}</span>
                    <span>赠送 ¥{balance.granted}</span>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm text-amber-200">{balanceErr || '查询中…'}</p>
              )}
            </div>
          ) : provider === 'doubao' ? (
            <div className="rounded-2xl bg-gradient-to-br from-[#1f4e5f] to-[#2e6b7e] p-4 text-white shadow-lg shadow-cyan-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-cyan-200" />
                  <p className="text-xs tracking-widest text-cyan-100">豆包 · 本机用量估算</p>
                </div>
                <button onClick={() => setDbUsage(getDoubaoUsage())} className="rounded-full bg-white/15 p-1.5 active:scale-90">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-2 text-3xl font-bold">{dbUsage.calls}<span className="ml-1 text-xs font-normal text-cyan-200">次调用</span></p>
              <div className="mt-1.5 flex gap-4 text-[11px] text-cyan-100/85">
                <span>输入 {dbUsage.prompt.toLocaleString()} tokens</span>
                <span>输出 {dbUsage.completion.toLocaleString()} tokens</span>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-gradient-to-br from-[#1e3a8a] to-[#3b62c4] p-4 text-white shadow-lg shadow-blue-200">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-200" />
                <p className="text-xs tracking-widest text-blue-100">Gemini · Google AI Studio</p>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-blue-100/90">
                当前模型：<span className="font-bold text-white">{getGeminiModel()}</span>
              </p>
            </div>
          )}

          {/* AI 接入：DeepSeek / 豆包 双模型 */}
          <div className="rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[#c44d7d]" />
              <p className="text-sm font-bold text-[#c44d7d]">AI 接入</p>
              {aiReady && (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-500">
                  <Check className="h-3 w-3" /> 已接入
                </span>
              )}
            </div>

            {/* 模型切换 */}
            <div className="mt-3 flex gap-2">
              {(['deepseek', 'doubao', 'gemini'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => switchProvider(p)}
                  className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-all active:scale-95 ${
                    provider === p
                      ? 'bg-gradient-to-r from-indigo-400 to-purple-400 text-white shadow-md shadow-indigo-200'
                      : 'bg-[#fbeef5] text-[#b0678c]'
                  }`}
                >
                  {PROVIDER_NAME[p]}
                </button>
              ))}
            </div>

            {aiReady ? (
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-[#a06f8b]">密钥只保存在这台手机上</p>
                <button
                  onClick={() => {
                    clearApiKey(provider)
                    setAiReady(false)
                    setBalance(null)
                  }}
                  className="text-xs text-red-400 underline underline-offset-2"
                >
                  移除
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <div className="flex items-center gap-2 rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={
                      provider === 'deepseek'
                        ? '粘贴 sk- 开头的 DeepSeek 密钥'
                        : provider === 'doubao'
                          ? '粘贴豆包的 API Key'
                          : '粘贴 Gemini 的 API Key'
                    }
                    className="w-full bg-transparent text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
                  />
                  <button onClick={() => setShowKey(!showKey)} className="shrink-0 text-pink-300">
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {provider === 'doubao' && (
                  <input
                    value={epInput}
                    onChange={(e) => setEpInput(e.target.value)}
                    placeholder="接入点 ID 或模型 ID（ep- 或 doubao- 开头）"
                    className="mt-2 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
                  />
                )}
                {provider === 'gemini' && (
                  <>
                    <input
                      value={geminiModelInput}
                      onChange={(e) => setGeminiModelInput(e.target.value)}
                      placeholder={`模型名（留空默认 ${getGeminiModel()}）`}
                      className="mt-2 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
                    />
                    <input
                      value={geminiBaseInput}
                      onChange={(e) => setGeminiBaseInput(e.target.value)}
                      placeholder="接口地址（留空走官方；国内中转填中转站给的地址）"
                      className="mt-2 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
                    />
                  </>
                )}
                {keyMsg && <p className="mt-1.5 text-xs text-red-400">{keyMsg}</p>}
                <button
                  onClick={() => {
                    const k = keyInput.trim()
                    if (!k) { setKeyMsg('先粘贴密钥哦'); return }
                    if (provider === 'doubao' && !epInput.trim()) {
                      setKeyMsg('豆包还需要接入点 ID 或模型 ID')
                      return
                    }
                    setApiKey(k, provider)
                    if (provider === 'doubao') setDoubaoEndpoint(epInput)
                    if (provider === 'gemini') {
                      if (geminiModelInput.trim()) setGeminiModel(geminiModelInput)
                      if (geminiBaseInput.trim()) setGeminiBaseUrl(geminiBaseInput)
                    }
                    setAiReady(isReady(provider))
                    setKeyInput('')
                    setEpInput('')
                    setGeminiModelInput('')
                    setGeminiBaseInput('')
                    setKeyMsg('')
                  }}
                  className="mt-2.5 w-full rounded-xl bg-gradient-to-r from-pink-400 to-rose-400 py-2.5 text-sm font-semibold text-white shadow-md shadow-pink-200 active:scale-95"
                >
                  保存并接入
                </button>
              </div>
            )}
          </div>

          {/* 生图模式配置：豆包 Seedream 图像接入点 */}
          <div className="rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
            <div className="flex items-center gap-2">
              <ImagePlus className="h-4 w-4 text-[#c44d7d]" />
              <p className="text-xs font-bold tracking-widest text-[#c44d7d]">生图模式 · 豆包 Seedream</p>
              <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${imgReady ? 'bg-emerald-50 text-emerald-500' : 'bg-gray-100 text-gray-400'}`}>
                {imgReady ? '已就绪' : '未配置'}
              </span>
            </div>
            {imgReady ? (
              <p className="mt-2 flex items-center gap-2 text-[11px] leading-relaxed text-[#a06f8b]">
                图像接入点已配置
                <button
                  onClick={() => { setImageEndpoint(''); setImgReady(false) }}
                  className="text-red-400 underline underline-offset-2"
                >
                  移除
                </button>
              </p>
            ) : (
              <div className="mt-2.5">
                <input
                  value={imgEpInput}
                  onChange={(e) => setImgEpInput(e.target.value)}
                  placeholder="图像模型的接入点 ID（ep- 开头）"
                  className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
                />
                <button
                  onClick={() => {
                    const ep = imgEpInput.trim()
                    if (!ep) return
                    setImageEndpoint(ep)
                    setImgEpInput('')
                    setImgReady(isImageReady())
                  }}
                  className="mt-2 w-full rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 py-2.5 text-sm font-semibold text-white shadow-md shadow-amber-200 active:scale-95"
                >
                  保存图像接入点
                </button>
              </div>
            )}
          </div>

          {/* 速度/质量一键预设 */}
          <div className="flex gap-2">
            <button
              onClick={() => {
                switchProvider('doubao')
                setCollab(false)
                localStorage.setItem(COLLAB_KEY, '0')
              }}
              className={`flex-1 rounded-2xl p-3 text-left transition-all active:scale-[0.97] ${
                provider === 'doubao' && !collab
                  ? 'bg-gradient-to-r from-cyan-400 to-sky-400 text-white shadow-md shadow-cyan-200'
                  : 'bg-white text-[#b0678c] shadow-md shadow-pink-100'
              }`}
            >
              <p className="text-sm font-bold">⚡ 快写模式</p>
              <p className={`mt-0.5 text-[10px] ${provider === 'doubao' && !collab ? 'text-cyan-50' : 'text-pink-300'}`}>
                豆包主写 · 秒出剧情
              </p>
            </button>
            <button
              onClick={() => {
                if (!bothReady()) return
                switchProvider('deepseek')
                setCollab(true)
                localStorage.setItem(COLLAB_KEY, '1')
              }}
              disabled={!bothReady()}
              className={`flex-1 rounded-2xl p-3 text-left transition-all active:scale-[0.97] disabled:opacity-50 ${
                collab && bothReady()
                  ? 'bg-gradient-to-r from-indigo-400 to-purple-400 text-white shadow-md shadow-indigo-200'
                  : 'bg-white text-[#b0678c] shadow-md shadow-pink-100'
              }`}
            >
              <p className="text-sm font-bold">✨ 精修模式</p>
              <p className={`mt-0.5 text-[10px] ${collab && bothReady() ? 'text-indigo-100' : 'text-pink-300'}`}>
                {bothReady() ? `${PROVIDER_NAME[provider]} 主写 + ${PROVIDER_NAME[otherReady(provider) ?? provider]} 润色` : '需两家密钥都配好'}
              </p>
            </button>
          </div>

          {/* 双 AI 协作开关 */}
          <button
            onClick={toggleCollab}
            disabled={!bothReady()}
            className={`flex w-full items-center gap-3 rounded-2xl p-4 shadow-md transition-all active:scale-[0.98] ${
              collab && bothReady()
                ? 'bg-gradient-to-r from-indigo-50 to-purple-50 shadow-indigo-100 ring-1 ring-indigo-200'
                : 'bg-white shadow-pink-100'
            }`}
          >
            <Sparkles className={`h-5 w-5 ${collab && bothReady() ? 'text-indigo-400' : 'text-pink-300'}`} />
            <div className="flex-1 text-left">
              <p className="text-sm font-bold text-[#c44d7d]">双 AI 协作</p>
              <p className="mt-0.5 text-[11px] text-[#a06f8b]">
                {bothReady()
                  ? collab
                    ? `${PROVIDER_NAME[provider]} 主写 · ${PROVIDER_NAME[otherReady(provider) ?? provider]} 润色（每段两次调用）`
                    : '开启后一家主写、另一家润色，文笔融合两家之长'
                  : '把 DeepSeek 和豆包都配好就能开启'}
              </p>
            </div>
            <div className={`h-6 w-11 rounded-full p-0.5 transition-colors ${collab && bothReady() ? 'bg-indigo-400' : 'bg-pink-200'}`}>
              <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${collab && bothReady() ? 'translate-x-5' : ''}`} />
            </div>
          </button>

          {/* 故事榜单入口 */}
          <button
            onClick={() => setView('board')}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 py-3 text-sm font-bold text-white shadow-md shadow-amber-200 active:scale-[0.98]"
          >
            <Trophy className="h-4 w-4" /> 故事榜单
            {board.length > 0 && <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10px]">{board.length} 本在榜</span>}
          </button>

          {/* 后台世界观任务：生成中可回来看进度，生成完点这里继续开局 */}
          {starting && !draft && (
            <button
              onClick={() => setView('setup')}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-100 to-indigo-100 py-3 text-sm font-semibold text-violet-500 shadow-md shadow-indigo-100 active:scale-[0.98]"
            >
              <Loader2 className="h-4 w-4 animate-spin" /> 正在后台构建世界观，点我看进度
            </button>
          )}
          {draft && (
            <button
              onClick={() => setView('wvreview')}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-400 to-indigo-400 py-3 text-sm font-bold text-white shadow-md shadow-indigo-200 active:scale-[0.98]"
            >
              <BookOpen className="h-4 w-4" /> 「{draft.title}」的世界观已就绪，继续开局
            </button>
          )}

          {/* 故事列表 */}
          <div className="space-y-3">
            {stories.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
                <button
                  onClick={() => { setCurrent(s); setView('game') }}
                  className="flex-1 text-left"
                >
                  <p className="text-sm font-bold text-[#c44d7d]">
                    {s.bookName || s.title}
                    {s.ended && (
                      <span className={`ml-2 rounded-full px-2 py-0.5 text-[9px] font-semibold ${s.endingType === '死亡' ? 'bg-gray-800 text-gray-200' : 'bg-emerald-100 text-emerald-600'}`}>
                        {s.endingType === '死亡' ? '💀 已死亡' : '已完结'}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 line-clamp-1 text-xs text-[#a06f8b]">
                    {s.msgs.length > 0 ? s.msgs[s.msgs.length - 1].content : '还没开始'}
                  </p>
                </button>
                <button
                  onClick={() => setDeleteTarget(s)}
                  className="shrink-0 rounded-full p-2 text-pink-300 active:bg-pink-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}

            <button
              onClick={() => aiReady ? setView('setup') : setKeyMsg('先完成 AI 接入才能开新故事哦')}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-pink-300 bg-white/60 py-4 text-sm font-semibold text-[#c44d7d] active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" /> 开启新故事
            </button>
          </div>
        </div>

        {/* 删除确认弹层 */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-8" onClick={() => setDeleteTarget(null)}>
            <div className="w-full max-w-xs rounded-3xl bg-white p-5 text-center shadow-xl" onClick={(e) => e.stopPropagation()}>
              <Trash2 className="mx-auto h-8 w-8 text-red-400" />
              <p className="mt-3 text-sm font-bold text-[#c44d7d]">确定删掉「{deleteTarget.bookName || deleteTarget.title}」吗？</p>
              <p className="mt-1.5 text-xs text-[#a06f8b]">剧情、关系网和世界观都会一起删掉，找不回来</p>
              <div className="mt-4 flex gap-2">
                <button onClick={() => setDeleteTarget(null)} className="flex-1 rounded-xl bg-pink-50 py-2.5 text-sm text-[#b0678c]">
                  再想想
                </button>
                <button
                  onClick={() => {
                    localStorage.removeItem(portraitKey(deleteTarget.id)) // 一并清掉形象图
                    setStories(deleteStory(user.name, deleteTarget.id))
                    setDeleteTarget(null)
                  }}
                  className="flex-1 rounded-xl bg-red-400 py-2.5 text-sm font-semibold text-white"
                >
                  确认删除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ================= 视图：开局引导 ================= */
  if (view === 'setup') {
    const formReady = setup.heroName.trim() && setup.genre.trim() && setup.background.trim() && setup.personality.trim() && setup.appearance.trim()
    const field = (
      label: string,
      key: keyof StorySetup,
      placeholder: string,
      suggests?: string[],
      hint?: string,
    ) => (
      <div className="rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
        <p className="text-xs font-bold tracking-widest text-[#c44d7d]">{label}</p>
        <input
          value={setup[key] as string}
          onChange={(e) => setSetup({ ...setup, [key]: e.target.value })}
          placeholder={placeholder}
          className="mt-2 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
        />
        {suggests && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggests.map((s) => (
              <button
                key={s}
                onClick={() => setSetup({ ...setup, [key]: s })}
                className="rounded-full bg-[#fbeef5] px-2.5 py-1 text-[11px] text-[#b0678c] active:bg-pink-200"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {hint && <p className="mt-2 text-[10px] leading-relaxed text-pink-300">{hint}</p>}
      </div>
    )

    return (
      <div className="flex min-h-dvh flex-col bg-gradient-to-b from-[#fdf1f6] to-[#f9e4ef]">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
          <button onClick={() => setView('list')} className="rounded-full p-1.5 text-[#c44d7d] active:bg-pink-100">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Sparkles className="h-5 w-5 text-[#c44d7d]" />
          <p className="text-base font-bold text-[#c44d7d]">塑造你的世界</p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 pb-8">
          {field('主角姓名', 'heroName', '给 TA 起个名字')}
          {field('性别', 'gender', '女 / 男 / 自定义', SUGGEST.gender)}
          {field('年龄', 'age', '比如 18 岁（AI 会补齐这些年的前传）', ['16 岁', '18 岁', '22 岁', '25 岁'])}
          {field('性格', 'personality', '随便写，越具体越好', SUGGEST.personality)}
          {field('长相', 'appearance', '发型、眼睛、气质…', SUGGEST.appearance)}
          {field('题材', 'genre', '想玩什么类型的故事', SUGGEST.genre, '填「修仙 / 武侠 / 都市 / 悬疑 / 异世界 / 末日 / 校园」会自动启用对应玩法系统，开局随机 roll 面板')}
          {field('背景设定', 'background', '故事发生在哪里、什么时代', SUGGEST.background)}
          {field('开局穿搭', 'outfit', '开场时主角穿什么（可留空）')}
          {field('开局资金', 'funds', '比如 1000 金币 / 3 两银子')}

          {/* 写作渠道：协作 or 独写（独写跳过润色，出稿快一倍） */}
          <div className="rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
            <p className="text-xs font-bold tracking-widest text-[#c44d7d]">写作渠道</p>
            <div className="mt-2.5 grid grid-cols-4 gap-2">
              {(
                [
                  { id: 'collab', name: '双AI协作', desc: '一写一润' },
                  { id: 'deepseek', name: 'DeepSeek', desc: '独写' },
                  { id: 'doubao', name: '豆包', desc: '独写' },
                  { id: 'gemini', name: 'Gemini', desc: '独写' },
                ] as const
              ).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChannel(c.id)}
                  className={`rounded-xl px-2 py-2.5 text-center transition-all active:scale-95 ${
                    channel === c.id
                      ? 'bg-gradient-to-r from-indigo-400 to-purple-400 text-white shadow-md shadow-indigo-200'
                      : 'bg-[#fbeef5] text-[#b0678c]'
                  }`}
                >
                  <p className="text-xs font-bold">{c.name}</p>
                  <p className={`mt-0.5 text-[9px] ${channel === c.id ? 'text-white/80' : 'text-pink-300'}`}>{c.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* 语言风格插件 */}
          <div className="rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
            <p className="text-xs font-bold tracking-widest text-[#c44d7d]">语言风格插件 <span className="font-normal text-pink-300">（可全选，自由搭配）</span></p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {STYLE_PLUGINS.map((p) => {
                const on = setup.styles.includes(p.id)
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      const styles = on
                        ? setup.styles.filter((id) => id !== p.id)
                        : [...setup.styles, p.id]
                      setSetup({ ...setup, styles })
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs transition-all active:scale-95 ${
                      on
                        ? 'bg-gradient-to-r from-indigo-400 to-purple-400 font-semibold text-white shadow-md shadow-indigo-200'
                        : 'bg-[#fbeef5] text-[#b0678c]'
                    }`}
                  >
                    {p.name}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 写作插件：自制规则，勾选后这个故事全程生效 */}
          <div className="rounded-2xl bg-white p-4 shadow-md shadow-pink-100">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold tracking-widest text-[#c44d7d]">
                写作插件 <span className="font-normal text-pink-300">（自制规则，勾选调用）</span>
              </p>
              <button
                onClick={() => openPluginModal()}
                className="flex shrink-0 items-center gap-1 rounded-full bg-gradient-to-r from-indigo-400 to-purple-400 px-3 py-1.5 text-[11px] font-bold text-white shadow-md shadow-indigo-200 active:scale-95"
              >
                <Plus className="h-3 w-3" /> 制作插件
              </button>
            </div>
            {myPlugins.length === 0 ? (
              <p className="mt-2.5 text-[11px] leading-relaxed text-pink-300">
                还没有插件。把你常用的写法要求做成插件，比如「每段结尾埋一个悬念」「对话要多用四川口音」，开故事时勾选就会全程生效
              </p>
            ) : (
              <div className="mt-2.5 space-y-2">
                {myPlugins.map((p) => {
                  const on = (setup.pluginIds ?? []).includes(p.id)
                  return (
                    <div
                      key={p.id}
                      className={`flex items-center gap-2 rounded-xl px-3 py-2 transition-all ${
                        on ? 'bg-gradient-to-r from-indigo-50 to-purple-50 ring-1 ring-indigo-200' : 'bg-[#fdf6fa]'
                      }`}
                    >
                      <button onClick={() => togglePlugin(p.id)} className="min-w-0 flex-1 text-left">
                        <p className={`truncate text-xs font-bold ${on ? 'text-indigo-500' : 'text-[#b0678c]'}`}>
                          {on ? '✅ ' : ''}{p.name}
                        </p>
                        <p className="mt-0.5 truncate text-[10px] text-pink-300">{p.rule}</p>
                      </button>
                      <button onClick={() => openPluginModal(p)} className="shrink-0 rounded-full p-1.5 text-pink-300 active:bg-pink-100">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          setMyPlugins(removePlugin(user.name, p.id))
                          const cur = setup.pluginIds ?? []
                          if (cur.includes(p.id)) setSetup({ ...setup, pluginIds: cur.filter((x) => x !== p.id) })
                        }}
                        className="shrink-0 rounded-full p-1.5 text-red-300 active:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 插件制作/编辑弹窗 */}
          {pluginModal && (
            <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 backdrop-blur-sm">
              <div className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-2xl">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-[#c44d7d]">{pluginModal.id ? '编辑插件' : '制作插件'}</p>
                  <button onClick={() => setPluginModal(null)} className="rounded-full p-1.5 text-pink-300 active:bg-pink-50">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <input
                  value={pluginName}
                  onChange={(e) => setPluginName(e.target.value)}
                  placeholder="插件名，比如「悬念制造机」"
                  maxLength={12}
                  className="mt-4 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
                />
                <textarea
                  value={pluginRule}
                  onChange={(e) => setPluginRule(e.target.value)}
                  rows={5}
                  placeholder="规则内容，写给 AI 看的要求。比如：每段结尾都要埋一个钩子，让读者想继续；打斗场面一招一式写清楚，不许一笔带过"
                  className="mt-3 w-full resize-none rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm leading-relaxed text-[#8a4a68] outline-none placeholder:text-pink-300"
                />
                <button
                  onClick={savePlugin}
                  disabled={!pluginName.trim() || !pluginRule.trim()}
                  className="mt-4 w-full rounded-xl bg-gradient-to-r from-indigo-400 to-purple-400 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 active:scale-95 disabled:opacity-40"
                >
                  保存插件
                </button>
              </div>
            </div>
          )}

          {/* 玩法系统匹配提示：按题材关键词自动启用 */}
          {(() => {
            const sys = detectGenreSystem(`${setup.genre} ${setup.background}`)
            if (!sys) return null
            return (
              <div className="rounded-2xl bg-gradient-to-r from-violet-50 to-indigo-50 p-3.5 ring-1 ring-violet-200">
                <p className="text-xs font-bold text-violet-500">🎮 已匹配玩法系统：{sys.name}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-violet-400">
                  面板：{sys.fields.join(' / ')} · AI 每段自动结算数值，剧情完全跟着你的行动走
                </p>
              </div>
            )
          })()}

          {startErr && <p className="text-center text-xs text-red-400">{startErr}</p>}

          <button
            onClick={() => void genWorldview()}
            disabled={!formReady || starting}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-400 to-purple-500 py-3.5 text-base font-bold text-white shadow-lg shadow-indigo-200 transition-transform active:scale-95 disabled:opacity-40"
          >
            {starting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> {startStep || '正在准备…'}
              </>
            ) : (
              <>
                <BookOpen className="h-4 w-4" /> 开始故事
              </>
            )}
          </button>
          {starting && (
            /* 世界观生成进度条：按已生成字数估算 */
            <div className="space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-pink-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-purple-400 transition-all duration-300"
                  style={{ width: `${Math.max(6, Math.min(95, streamText.length / 4.5))}%` }}
                />
              </div>
              <p className="text-center text-[11px] text-pink-300">
                {startStep}{streamText ? `（已生成 ${streamText.length} 字）` : '（正在连接 AI…）'}
              </p>
            </div>
          )}
          {!formReady && <p className="text-center text-[11px] text-pink-300">姓名、性格、长相、题材、背景填好就能开局啦</p>}
        </div>
      </div>
    )
  }

  /* ================= 视图：世界观确认 ================= */
  if (view === 'wvreview' && draft) {
    return (
      <div className="flex min-h-dvh flex-col bg-gradient-to-b from-[#fdf1f6] to-[#f9e4ef]">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
          <button onClick={() => setView('setup')} className="rounded-full p-1.5 text-[#c44d7d] active:bg-pink-100">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <BookOpen className="h-5 w-5 text-[#c44d7d]" />
          <p className="text-base font-bold text-[#c44d7d]">确认世界观</p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-8">
          <p className="text-xs leading-relaxed text-[#a06f8b]">
            这是 AI 根据你填的设定补齐的世界观和人物前传，之后会作为这个故事的根基。读一遍，不满意可以改或者重新生成。
          </p>

          <textarea
            value={wvDraft}
            onChange={(e) => setWvDraft(e.target.value)}
            rows={14}
            className="w-full rounded-2xl border border-pink-200 bg-white p-4 text-sm leading-[1.9] text-[#5d3a4e] shadow-md shadow-pink-100 outline-none"
          />

          {startErr && <p className="text-center text-xs text-red-400">{startErr}</p>}

          {starting && (
            /* 开场/重生成进度条：按已生成字数估算，润色阶段顶到 97% */
            <div className="space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-pink-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-purple-400 transition-all duration-300"
                  style={{
                    width: `${polishing ? 97 : Math.max(6, Math.min(94, streamText.length / (startStep.includes('世界观') ? 4.5 : 2.2)))}%`,
                  }}
                />
              </div>
              <p className="text-center text-[11px] text-pink-300">
                {polishing
                  ? '另一家 AI 润色开场…'
                  : `${startStep}${streamText ? `（已生成 ${streamText.length} 字）` : '（正在连接 AI…）'}`}
              </p>
            </div>
          )}

          <div className="flex gap-2.5">
            <button
              onClick={() => void genWorldview()}
              disabled={starting}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white py-3 text-sm font-semibold text-[#c44d7d] shadow-md shadow-pink-100 active:scale-95 disabled:opacity-50"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              重新生成
            </button>
            <button
              onClick={() => void confirmStart()}
              disabled={starting || !wvDraft.trim()}
              className="flex flex-[2] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-400 to-purple-500 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-200 active:scale-95 disabled:opacity-50"
            >
              {starting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {startStep || '生成中…'}</>
              ) : (
                <><Check className="h-4 w-4" /> 就它了，开启故事</>
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ================= 视图：故事榜单 ================= */
  if (view === 'board') {
    const medal = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`)
    return (
      <div className="flex min-h-dvh flex-col bg-gradient-to-b from-[#fdf6ec] to-[#fbeeddf0]">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
          <button onClick={() => setView('list')} className="rounded-full p-1.5 text-[#c44d7d] active:bg-pink-100">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Trophy className="h-5 w-5 text-amber-500" />
          <p className="text-base font-bold text-[#c44d7d]">故事榜单</p>
          <span className="ml-auto text-[10px] text-pink-300">两台手机实时同步</span>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 pb-8">
          {board.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Trophy className="h-10 w-10 text-amber-200" />
              <p className="text-xs leading-relaxed text-[#b78aa5]">榜单还空着<br />完结一个故事、评分上传，就能占下第一名</p>
            </div>
          )}
          {board.map((b, i) => (
            <div key={b.id} className={`rounded-2xl bg-white p-4 shadow-md ${i === 0 ? 'ring-2 ring-amber-300 shadow-amber-100' : 'shadow-pink-100'}`}>
              <div className="flex items-center gap-3">
                <p className={`w-8 text-center text-lg font-bold ${i < 3 ? '' : 'text-sm text-pink-300'}`}>{medal(i)}</p>
                <div className="flex-1">
                  <p className="text-sm font-bold text-[#c44d7d]">《{b.bookName}》</p>
                  <p className="mt-0.5 text-[11px] text-[#a06f8b]">
                    {b.author} 著 · {b.genre} · {b.endingType === '死亡' ? '💀 死亡结局' : b.endingType}
                  </p>
                </div>
                <div className="text-right text-[11px]">
                  <p className="font-bold text-rose-500">幸福 {b.happiness}</p>
                  <p className="mt-0.5 font-bold text-indigo-500">精彩 {b.brilliance}</p>
                </div>
              </div>
              {b.comment && (
                <p className="mt-2.5 rounded-xl bg-[#fbeef5] px-3 py-2 text-xs leading-relaxed text-[#8a4a68]">{b.comment}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  /* ================= 视图：游戏中 ================= */
  if (!current) return null
  const shownPanel = livePanel ?? current.panel
  const gameSys = storySystem(current)
  const usableKeys = gameSys ? (USABLE_FIELDS[gameSys.id] ?? []) : []
  return (
    <div className="flex h-dvh flex-col bg-gradient-to-b from-[#fdf1f6] to-[#f9e4ef]">
      {/* 顶栏：返回 / 标题 / 关系网 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
        <button onClick={() => { setView('list'); setCurrent(null) }} className="rounded-full p-1.5 text-[#c44d7d] active:bg-pink-100">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <p className="flex-1 truncate text-sm font-bold text-[#c44d7d]">{current.title}</p>
        {!current.ended && (
          <button
            onClick={() => setEndConfirm(true)}
            className="flex items-center gap-1 rounded-full bg-[#fdf3e7] px-3 py-1.5 text-xs font-semibold text-amber-600 active:scale-95"
          >
            <Flag className="h-3.5 w-3.5" /> 故事结束
          </button>
        )}
        {!!current.worldview && (
          <button
            onClick={() => setWvOpen(true)}
            className="flex items-center gap-1 rounded-full bg-[#eef0fc] px-3 py-1.5 text-xs font-semibold text-indigo-500 active:scale-95"
          >
            <BookOpen className="h-3.5 w-3.5" /> 世界观
          </button>
        )}
        <button
          onClick={openPortrait}
          className="rounded-full bg-[#fdf3e7] p-2 text-amber-500 transition-transform active:scale-95"
          title="主角形象图"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setRelOpen(true)}
          className="relative flex items-center gap-1 rounded-full bg-[#fbeef5] px-3 py-1.5 text-xs font-semibold text-[#c44d7d] active:scale-95"
        >
          <UsersRound className="h-3.5 w-3.5" /> 关系网
          {current.relations.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-400 px-1 text-[9px] font-bold text-white">
              {current.relations.length}
            </span>
          )}
        </button>
      </div>

      {/* 档案条：资金 / 状态 / 穿搭 */}
      <button
        onClick={() => {
          setStateDraft({ ...current.state })
          setStateEdit(true)
        }}
        className="flex items-center gap-2 overflow-x-auto bg-white/60 px-4 py-2 text-left backdrop-blur"
      >
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] text-amber-600">
          <Coins className="h-3 w-3" /> {current.state.funds}
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-600">
          <UserRound className="h-3 w-3" /> {current.state.status}
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-[11px] text-sky-600">
          <Shirt className="h-3 w-3" /> {current.state.outfit}
        </span>
        <Pencil className="h-3 w-3 shrink-0 text-pink-300" />
      </button>

      {/* 物品栏：剧情中出现的道具自动收录进这里，点「用」投进聊天框，发送即生效 */}
      {(() => {
        const barItems = parseItems((current.items ?? []).join('、'))
        if (barItems.length === 0) return null
        return (
          <div className="bg-white/60 px-4 py-2 backdrop-blur">
            <p className="text-[10px] font-bold tracking-widest text-amber-500">物品栏</p>
            <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
              {barItems.map((it) => (
                <span
                  key={it.name}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 py-1 pr-1 pl-2.5 text-[11px] text-amber-700 shadow-sm"
                >
                  {it.name}
                  {it.count > 1 && <span className="text-amber-400">×{it.count}</span>}
                  <button
                    onClick={() => useItem(it.name)}
                    disabled={sending || !!current.ended}
                    className="ml-0.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-400 px-1.5 py-0.5 text-[9px] font-bold text-white transition-transform active:scale-90 disabled:opacity-40"
                  >
                    用
                  </button>
                </span>
              ))}
            </div>
          </div>
        )
      })()}

      {/* 玩法面板：默认收成左下角悬浮按钮，点开查看，叉掉收回 */}
      {shownPanel && Object.keys(shownPanel).length > 0 &&
        (panelOpen ? (
          <div className="fixed bottom-24 left-3 z-40 max-h-[52dvh] w-[calc(100%-1.5rem)] max-w-sm overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-2xl shadow-violet-200 ring-1 ring-violet-100 backdrop-blur">
            <div className="flex items-center gap-1.5">
              <Gamepad2 className="h-3 w-3 text-violet-400" />
              <p className="text-[10px] font-bold tracking-widest text-violet-500">玩法面板</p>
              <button
                onClick={() => setPanelOpen(false)}
                className="ml-auto rounded-full p-1 text-violet-300 transition-transform active:scale-90 active:bg-violet-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {Object.entries(shownPanel).map(([k, v]) => {
                const isItemField = usableKeys.includes(k)
                const items = isItemField ? parseItems(v) : []
                return (
                  <div key={k} className="rounded-lg bg-violet-50/70 px-2 py-1.5">
                    <p className="text-[9px] text-violet-400">{k}</p>
                    {isItemField && items.length > 0 ? (
                      /* 道具栏：每个道具一行，点「用」投进聊天框，发送即生效 */
                      <div className="mt-1 space-y-1">
                        {items.map((it) => (
                          <div key={it.name} className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[11px] text-violet-700">
                              {it.name}
                              {it.count > 1 && <span className="text-violet-400"> ×{it.count}</span>}
                            </span>
                            <button
                              onClick={() => useItem(it.name)}
                              disabled={sending || !!current.ended}
                              className="shrink-0 rounded-full bg-gradient-to-r from-violet-400 to-purple-400 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm transition-transform active:scale-90 disabled:opacity-40"
                            >
                              用
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-0.5 text-[11px] leading-snug break-words text-violet-700">{v}</p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <button
            onClick={() => setPanelOpen(true)}
            className="fixed bottom-24 left-3 z-40 flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-2 text-[10px] font-bold text-violet-500 shadow-lg shadow-violet-100 ring-1 ring-violet-100 backdrop-blur transition-transform active:scale-95"
          >
            <Gamepad2 className="h-3.5 w-3.5" /> 面板
          </button>
        ))}

      {/* 危机横幅：下一步应对决定生死 */}
      {!!current.pendingCrisis && !current.ended && (
        <div className="flex items-center gap-2 bg-gradient-to-r from-red-500 to-rose-500 px-4 py-2 text-white">
          <Skull className="h-4 w-4 shrink-0 animate-pulse" />
          <p className="text-xs leading-snug">
            <span className="font-bold">生死危机：</span>{current.pendingCrisis} —— 你的下一步应对将决定{current.setup.heroName}的生死
          </p>
        </div>
      )}

      {/* 新人物加入关系网的浮动提示 */}
      {charNotice && (
        <div className="fixed top-24 left-1/2 z-40 -translate-x-1/2 rounded-full bg-gradient-to-r from-indigo-400 to-purple-400 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-300">
          ✨ {charNotice}
        </div>
      )}

      {/* 突发事件浮动提示 */}
      {eventNotice && (
        <div className={`fixed top-24 left-1/2 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-semibold text-white shadow-lg ${
          eventNotice.crisis ? 'bg-gradient-to-r from-red-500 to-rose-500 shadow-red-300' : 'bg-gradient-to-r from-amber-400 to-orange-400 shadow-amber-300'
        }`}>
          {eventNotice.crisis ? '⚡ 危机降临：' : '⚡ 突发事件：'}{eventNotice.text}
        </div>
      )}

      {/* 主角形象图弹窗：豆包 Seedream 生图 */}
      {portraitOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-6 backdrop-blur-sm" onClick={() => setPortraitOpen(false)}>
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-[#c44d7d]">主角形象图</p>
              <button onClick={() => setPortraitOpen(false)} className="rounded-full p-1.5 text-pink-300 active:bg-pink-50">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-pink-50">
              {portraitBusy ? (
                <div className="flex flex-col items-center gap-2 text-pink-300">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <p className="text-xs">豆包绘图中，约 10~20 秒…</p>
                </div>
              ) : portraitImg ? (
                <img src={portraitImg} alt="主角形象" className="h-full w-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-pink-200">
                  <ImagePlus className="h-8 w-8" />
                  <p className="text-xs">还没有形象图，点下方生成</p>
                </div>
              )}
            </div>
            <textarea
              value={portraitPrompt}
              onChange={(e) => setPortraitPrompt(e.target.value)}
              rows={3}
              placeholder="形象提示词（已按设定自动填好，可改）"
              className="mt-3 w-full resize-none rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2 text-xs leading-relaxed text-[#8a4a68] outline-none placeholder:text-pink-300"
            />
            {portraitErr && <p className="mt-1.5 text-xs text-red-400">{portraitErr}</p>}
            <button
              onClick={() => void doGeneratePortrait()}
              disabled={portraitBusy || !portraitPrompt.trim()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 py-2.5 text-sm font-bold text-white shadow-md shadow-amber-200 transition-transform active:scale-95 disabled:opacity-40"
            >
              {portraitBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              {portraitImg ? '重新生成' : '生成形象图'}
            </button>
          </div>
        </div>
      )}

      {/* 剧情区 */}
      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {current.msgs.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-indigo-400 to-purple-400 px-3.5 py-2.5 text-sm leading-relaxed text-white">
                  {m.content}
                </div>
              </div>
            )
          }
          const { body, options } = splitGuidance(m.content)
          const isLast = i === current.msgs.length - 1
          return (
            <div key={i} className="space-y-2">
              <div className="rounded-2xl rounded-tl-sm bg-white px-4 py-3.5 text-sm leading-[1.9] text-[#5d3a4e] shadow-md shadow-pink-100 whitespace-pre-wrap">
                {body}
              </div>

              {/* 微信式聊天卡片：剧情里出现手机聊天时渲染 */}
              {m.chat && (
                <div className="overflow-hidden rounded-2xl shadow-md shadow-pink-100">
                  {/* 微信顶栏 */}
                  <div className="flex items-center justify-center bg-[#ededed] px-3 py-2.5">
                    <p className="text-[13px] font-medium text-[#181818]">{m.chat.title}</p>
                  </div>
                  {/* 聊天内容 */}
                  <div className="space-y-2.5 bg-[#ededed] px-3 pb-3.5">
                    {m.chat.messages.map((cm, ci) => {
                      const mine = cm.from === current.setup.heroName
                      return (
                        <div key={ci} className={`flex items-start gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white ${mine ? 'bg-gradient-to-br from-indigo-400 to-purple-400' : 'bg-gradient-to-br from-pink-400 to-rose-400'}`}>
                            {cm.from.slice(0, 1)}
                          </div>
                          <div
                            className={`max-w-[70%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                              mine ? 'bg-[#95ec69] text-[#181818]' : 'bg-white text-[#181818]'
                            }`}
                          >
                            {cm.text}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {isLast && options.length > 0 && !sending && (
                <div className="flex flex-wrap gap-2 pl-1">
                  {options.map((op) => (
                    <button
                      key={op}
                      onClick={() => void act(op)}
                      className="rounded-full border border-indigo-200 bg-white/80 px-3 py-1.5 text-xs text-indigo-500 shadow-sm transition-transform active:scale-95"
                    >
                      → {op}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {sending &&
          (streamText ? (
            /* 流式打字气泡：剧情逐字写出来；润色阶段保留原文并提示 */
            <div className="space-y-2">
              <div className="rounded-2xl rounded-tl-sm bg-white px-4 py-3.5 text-sm leading-[1.9] whitespace-pre-wrap text-[#5d3a4e] shadow-md shadow-pink-100">
                {streamPreview(streamText) || '…'}
                {!polishing && (
                  <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-indigo-400 align-middle" />
                )}
              </div>
              {polishing && (
                <div className="flex items-center gap-1.5 pl-1 text-[11px] text-violet-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> 另一家 AI 润色中，这版可以先看着
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 pl-1 text-sm text-[#b78aa5]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {polishing ? '另一家 AI 润色中…' : '正在构思剧情…'}
            </div>
          ))}
      </div>

      {chatErr && (
        <div className="flex items-center justify-center gap-2 px-4 pb-1">
          <p className="text-xs text-red-400">{chatErr}</p>
          {failedBase && (
            <button
              onClick={() => void generate(failedBase)}
              disabled={sending}
              className="shrink-0 rounded-full bg-red-50 px-3 py-1 text-[11px] font-semibold text-red-400 active:scale-95 disabled:opacity-40"
            >
              重试
            </button>
          )}
        </div>
      )}

      {current.ended ? (
        /* ===== 完结面板：命名 → 评分 → 上传榜单 ===== */
        <div className="space-y-3 border-t border-pink-100 bg-white/90 p-4 backdrop-blur">
          <div className="flex items-center gap-2">
            {current.endingType === '死亡' ? (
              <Skull className="h-4 w-4 text-gray-700" />
            ) : (
              <Flag className="h-4 w-4 text-amber-500" />
            )}
            <p className="text-sm font-bold text-[#c44d7d]">
              {current.endingType === '死亡' ? `「${current.setup.heroName}」的故事落幕了` : '故事已完结'}
            </p>
          </div>

          {!current.uploaded ? (
            <>
              <input
                value={bookName}
                onChange={(e) => setBookName(e.target.value)}
                placeholder="给这本书起个名字，比如《雨夜旧书店》"
                className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
              />

              {!current.score ? (
                <button
                  onClick={() => void scoreStory()}
                  disabled={scoring}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-400 to-purple-400 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-200 active:scale-95 disabled:opacity-50"
                >
                  {scoring ? <><Loader2 className="h-4 w-4 animate-spin" /> 评委打分中…</> : <><Sparkles className="h-4 w-4" /> 让 DeepSeek 评分</>}
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1 rounded-2xl bg-gradient-to-br from-pink-50 to-rose-50 p-3 text-center">
                      <p className="text-2xl font-bold text-rose-500">{current.score.happiness}</p>
                      <p className="text-[10px] tracking-widest text-rose-300">幸福指数</p>
                    </div>
                    <div className="flex-1 rounded-2xl bg-gradient-to-br from-indigo-50 to-purple-50 p-3 text-center">
                      <p className="text-2xl font-bold text-indigo-500">{current.score.brilliance}</p>
                      <p className="text-[10px] tracking-widest text-indigo-300">精彩程度</p>
                    </div>
                  </div>
                  <p className="rounded-xl bg-[#fbeef5] px-3.5 py-2.5 text-xs leading-relaxed text-[#8a4a68]">{current.score.comment}</p>
                  <button
                    onClick={uploadBook}
                    disabled={!bookName.trim()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 py-2.5 text-sm font-bold text-white shadow-md shadow-amber-200 active:scale-95 disabled:opacity-40"
                  >
                    <Trophy className="h-4 w-4" /> 上传到故事榜单
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 py-3 text-sm font-semibold text-emerald-600">
              <Check className="h-4 w-4" /> 《{current.bookName}》已上榜
            </div>
          )}
        </div>
      ) : (
        /* ===== 输入区 ===== */
        <div className="flex items-center gap-2 border-t border-pink-100 bg-white/80 p-3 backdrop-blur">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void act(input)}
            placeholder={current.pendingCrisis ? '危机当前，你如何应对…' : `${current.setup.heroName} 接下来做什么…`}
            disabled={sending}
            className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 disabled:opacity-50"
          />
          <button
            onClick={() => void act(input)}
            disabled={sending || !input.trim()}
            className="shrink-0 rounded-xl bg-gradient-to-r from-indigo-400 to-purple-400 p-2.5 text-white shadow-md shadow-indigo-200 transition-transform active:scale-90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      )}
      {!current.ended && (
        <p className="bg-white/80 px-4 pb-2 text-center text-[10px] text-pink-300 backdrop-blur">
          小提示：用（）把话括起来，可以和主持人闲聊、提问、吐槽，不会推进剧情
        </p>
      )}

      {/* 完结确认弹层 */}
      {endConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-8" onClick={() => setEndConfirm(false)}>
          <div className="w-full max-w-xs rounded-3xl bg-white p-5 text-center shadow-xl" onClick={(e) => e.stopPropagation()}>
            <Flag className="mx-auto h-8 w-8 text-amber-500" />
            <p className="mt-3 text-sm font-bold text-[#c44d7d]">要在这里完结这个故事吗？</p>
            <p className="mt-1.5 text-xs leading-relaxed text-[#a06f8b]">完结后不能再继续剧情，DeepSeek 会给整个故事打分，然后可以上传到故事榜单</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setEndConfirm(false)} className="flex-1 rounded-xl bg-pink-50 py-2.5 text-sm text-[#b0678c]">
                继续写
              </button>
              <button onClick={endStory} className="flex-1 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 py-2.5 text-sm font-semibold text-white">
                故事结束
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 关系网弹层 */}
      {relOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setRelOpen(false)}>
          <div
            className="max-h-[80dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="flex items-center gap-2 text-base font-bold text-[#c44d7d]">
                <UsersRound className="h-4 w-4" /> 人物关系网
              </p>
              <button onClick={() => setRelOpen(false)} className="rounded-full p-1 text-pink-300">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2.5">
              {/* 主角卡 */}
              <div className="rounded-2xl bg-gradient-to-r from-indigo-50 to-purple-50 p-3.5">
                <p className="text-sm font-bold text-indigo-500">{current.setup.heroName} <span className="text-[10px] font-normal text-indigo-300">主角</span></p>
                <p className="mt-1 text-xs leading-relaxed text-[#8a6f9b]">
                  {current.setup.gender} · {current.setup.personality} · {current.setup.appearance}
                </p>
              </div>

              {current.relations.map((r) => (
                <div key={r.id} className="flex items-start gap-2 rounded-2xl bg-[#fbeef5] p-3.5">
                  <button
                    className="flex-1 text-left"
                    onClick={() => setRelDraft(r)}
                  >
                    <p className="text-sm font-bold text-[#c44d7d]">{r.name} <span className="text-[10px] font-normal text-pink-400">{r.relation}</span></p>
                    {r.note && <p className="mt-1 text-xs leading-relaxed text-[#a06f8b]">{r.note}</p>}
                  </button>
                  <button
                    onClick={() => persist({ ...current, relations: current.relations.filter((x) => x.id !== r.id) })}
                    className="shrink-0 p-1 text-pink-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}

              {/* 添加 / 编辑人物 */}
              {relDraft ? (
                <div className="space-y-2 rounded-2xl border border-pink-200 p-3.5">
                  <input
                    value={relDraft.name}
                    onChange={(e) => setRelDraft({ ...relDraft, name: e.target.value })}
                    placeholder="人物姓名"
                    className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2 text-sm outline-none placeholder:text-pink-300"
                  />
                  <input
                    value={relDraft.relation}
                    onChange={(e) => setRelDraft({ ...relDraft, relation: e.target.value })}
                    placeholder="与主角的关系，如：青梅竹马"
                    className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2 text-sm outline-none placeholder:text-pink-300"
                  />
                  <textarea
                    value={relDraft.note}
                    onChange={(e) => setRelDraft({ ...relDraft, note: e.target.value })}
                    placeholder="补充：外貌 / 性格 / 背景（可留空）"
                    rows={2}
                    className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2 text-sm outline-none placeholder:text-pink-300"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setRelDraft(null)} className="flex-1 rounded-xl bg-pink-50 py-2 text-sm text-[#b0678c]">取消</button>
                    <button
                      onClick={() => {
                        if (!relDraft.name.trim()) return
                        const exists = current.relations.some((x) => x.id === relDraft.id)
                        const relations = exists
                          ? current.relations.map((x) => (x.id === relDraft.id ? relDraft : x))
                          : [...current.relations, relDraft]
                        persist({ ...current, relations })
                        setRelDraft(null)
                      }}
                      className="flex-1 rounded-xl bg-gradient-to-r from-indigo-400 to-purple-400 py-2 text-sm font-semibold text-white"
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setRelDraft({ id: uid(), name: '', relation: '', note: '' })}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-pink-300 py-3 text-sm font-semibold text-[#c44d7d] active:scale-[0.98]"
                >
                  <Plus className="h-4 w-4" /> 添加人物
                </button>
              )}
            </div>
            <p className="mt-3 text-center text-[10px] text-pink-300">关系网会随每次剧情同步给 AI，它写故事时永远记得这些人</p>
          </div>
        </div>
      )}

      {/* 世界观弹层 */}
      {wvOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setWvOpen(false)}>
          <div
            className="max-h-[75dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="flex items-center gap-2 text-base font-bold text-[#c44d7d]">
                <BookOpen className="h-4 w-4" /> 世界观与人物前传
              </p>
              <button onClick={() => setWvOpen(false)} className="rounded-full p-1 text-pink-300">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm leading-[1.9] text-[#5d3a4e] whitespace-pre-wrap">{current.worldview}</p>
            <p className="mt-4 text-center text-[10px] text-pink-300">这份设定会在每段剧情生成时同步给 AI</p>
          </div>
        </div>
      )}

      {/* 档案编辑弹层 */}
      {stateEdit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setStateEdit(false)}>
          <div className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <p className="text-base font-bold text-[#c44d7d]">修改档案</p>
              <button onClick={() => setStateEdit(false)} className="rounded-full p-1 text-pink-300">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-2.5">
              {(['funds', 'status', 'outfit'] as const).map((k) => (
                <input
                  key={k}
                  value={stateDraft[k]}
                  onChange={(e) => setStateDraft({ ...stateDraft, [k]: e.target.value })}
                  placeholder={k === 'funds' ? '资金' : k === 'status' ? '状态' : '穿搭'}
                  className="w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3 py-2.5 text-sm outline-none placeholder:text-pink-300"
                />
              ))}
              <button
                onClick={() => {
                  persist({ ...current, state: { ...stateDraft } })
                  setStateEdit(false)
                }}
                className="w-full rounded-xl bg-gradient-to-r from-indigo-400 to-purple-400 py-2.5 text-sm font-semibold text-white"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
