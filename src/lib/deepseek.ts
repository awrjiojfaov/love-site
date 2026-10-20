/**
 * AI 接入层：支持 DeepSeek 和豆包（火山引擎方舟），浏览器直连官方 API。
 * 密钥只存本机 localStorage，不进代码、不走第三方服务器；两台手机各自配置。
 */

export type Provider = 'deepseek' | 'doubao' | 'gemini'

const PROVIDER_KEY = 'ai-provider'
const KEY_STORAGE: Record<Provider, string> = {
  deepseek: 'deepseek-api-key',
  doubao: 'doubao-api-key',
  gemini: 'gemini-api-key',
}
const DOUBAO_ENDPOINT_KEY = 'doubao-endpoint'

export function getProvider(): Provider {
  return localStorage.getItem(PROVIDER_KEY) === 'doubao' ? 'doubao' : 'deepseek'
}

export function setProvider(p: Provider): void {
  localStorage.setItem(PROVIDER_KEY, p)
}

export function getApiKey(p: Provider = getProvider()): string {
  return localStorage.getItem(KEY_STORAGE[p]) ?? ''
}

export function setApiKey(key: string, p: Provider = getProvider()): void {
  localStorage.setItem(KEY_STORAGE[p], key.trim())
}

export function clearApiKey(p: Provider = getProvider()): void {
  localStorage.removeItem(KEY_STORAGE[p])
}

/** 豆包需要模型接入点 ID（ep- 开头），DeepSeek 不需要 */
export function getDoubaoEndpoint(): string {
  return localStorage.getItem(DOUBAO_ENDPOINT_KEY) ?? ''
}

export function setDoubaoEndpoint(ep: string): void {
  localStorage.setItem(DOUBAO_ENDPOINT_KEY, ep.trim())
}

/* ---------------- Gemini（OpenAI 兼容端点） ---------------- */

const GEMINI_BASE_KEY = 'gemini-base-url'
const GEMINI_MODEL_KEY = 'gemini-model'
/** 官方 OpenAI 兼容地址（需能访问 Google）；国内网络可在剧情工坊设置里改为中转站地址 */
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
/** 默认模型：官方 Flash 档（快）；想要更好的文笔可在设置里换成 pro 档模型 */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

export function getGeminiBaseUrl(): string {
  return (localStorage.getItem(GEMINI_BASE_KEY) ?? '').trim() || DEFAULT_GEMINI_BASE
}
export function setGeminiBaseUrl(url: string): void {
  localStorage.setItem(GEMINI_BASE_KEY, url.trim())
}
export function getGeminiModel(): string {
  return (localStorage.getItem(GEMINI_MODEL_KEY) ?? '').trim() || DEFAULT_GEMINI_MODEL
}
export function setGeminiModel(m: string): void {
  localStorage.setItem(GEMINI_MODEL_KEY, m.trim())
}

/* ---------------- 生图模式（豆包 Seedream 文生图） ---------------- */

const DOUBAO_IMAGE_EP_KEY = 'doubao-image-endpoint'
/** 默认图像接入点（豆包 Seedream），免配置开箱即用；本机另行保存的优先 */
const DEFAULT_IMAGE_EP = 'ep-20260826135342-vjp9g'

/** 图像模型的接入点 ID（ep- 开头），和对话接入点是两个 */
export function getImageEndpoint(): string {
  return localStorage.getItem(DOUBAO_IMAGE_EP_KEY) ?? DEFAULT_IMAGE_EP
}

export function setImageEndpoint(ep: string): void {
  localStorage.setItem(DOUBAO_IMAGE_EP_KEY, ep.trim())
}

/** 生图是否可用：豆包密钥 + 图像接入点都配好 */
export function isImageReady(): boolean {
  return !!getApiKey('doubao') && !!getImageEndpoint()
}

/**
 * 调用豆包 Seedream 文生图，返回 data URL（b64）。
 * size 默认 1024x1024；主角形象用竖版可传 "864x1152"。
 */
export async function generateImage(prompt: string, size = '1024x1024'): Promise<string> {
  const key = getApiKey('doubao')
  if (!key) throw new Error('先填入豆包的 API Key')
  const model = getImageEndpoint()
  if (!model) throw new Error('先填入图像模型的接入点 ID')

  const res = await requestWithRetry(() =>
    fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        size,
        response_format: 'b64_json',
        watermark: false,
      }),
    }),
  )
  if (res.status === 401) throw new Error('密钥无效，请检查后再试')
  if (res.status === 402) throw new Error('余额不足啦，先去充一点～')
  if (res.status === 404) throw new Error('图像接入点 ID 不对，检查一下 ep- 开头那串')
  if (!res.ok) throw new Error(`生图失败（${res.status}），稍后再试`)
  const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
  const b64 = data.data?.[0]?.b64_json
  if (b64) return `data:image/jpeg;base64,${b64}`
  const url = data.data?.[0]?.url
  if (url) return url
  throw new Error('这次没生成出图片，再试一次')
}

/** 当前服务商是否已配置完整、可以开工 */
export function isReady(p: Provider = getProvider()): boolean {
  if (!getApiKey(p)) return false
  return p === 'doubao' ? !!getDoubaoEndpoint() : true
}

export const ALL_PROVIDERS: Provider[] = ['deepseek', 'doubao', 'gemini']

/** 至少两家配好就能开双 AI 协作 */
export function bothReady(): boolean {
  return ALL_PROVIDERS.filter((p) => isReady(p)).length >= 2
}

/** 除主写之外第一个配好的服务商（协作模式自动选润色方） */
export function otherReady(writer: Provider): Provider | null {
  return ALL_PROVIDERS.find((p) => p !== writer && isReady(p)) ?? null
}

/* ---------------- 豆包本机用量估算 ---------------- */

const USAGE_KEY = 'doubao-usage'

export type DoubaoUsage = { calls: number; prompt: number; completion: number }

export function getDoubaoUsage(): DoubaoUsage {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    return raw ? (JSON.parse(raw) as DoubaoUsage) : { calls: 0, prompt: 0, completion: 0 }
  } catch {
    return { calls: 0, prompt: 0, completion: 0 }
  }
}

function recordDoubaoUsage(usage?: { prompt_tokens?: number; completion_tokens?: number }): void {
  if (!usage) return
  const cur = getDoubaoUsage()
  const next: DoubaoUsage = {
    calls: cur.calls + 1,
    prompt: cur.prompt + (usage.prompt_tokens ?? 0),
    completion: cur.completion + (usage.completion_tokens ?? 0),
  }
  localStorage.setItem(USAGE_KEY, JSON.stringify(next))
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/* ---------------- 网络错误自动重试 ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 可重试的错误：网络中断（TypeError，如切后台/信号波动导致断流）或 429/5xx */
function isRetryable(e: unknown): boolean {
  if (e instanceof TypeError) return true
  const status = (e as { status?: number }).status
  return status === 429 || (typeof status === 'number' && status >= 500)
}

/** 网络层的 fetch 重试：只兜 TypeError 断连，HTTP 状态错误由调用方处理 */
async function requestWithRetry(fn: () => Promise<Response>, retries = 2): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isRetryable(e) || i === retries) break
      await sleep(800 * (i + 1))
    }
  }
  throw lastErr
}

export type BalanceInfo = {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

/** 查询 DeepSeek 账户余额（豆包没有同类接口，账单去火山引擎控制台看） */
export async function fetchBalance(): Promise<BalanceInfo> {
  const key = getApiKey('deepseek')
  if (!key) throw new Error('还没有填入密钥')
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (res.status === 401) throw new Error('密钥无效，请检查后再试')
  if (!res.ok) throw new Error(`查询失败（${res.status}）`)
  const data = (await res.json()) as {
    is_available: boolean
    balance_infos: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]
  }
  const cny = data.balance_infos.find((b) => b.currency === 'CNY') ?? data.balance_infos[0]
  if (!cny) throw new Error('没查到余额信息')
  return {
    currency: cny.currency,
    total: cny.total_balance,
    granted: cny.granted_balance,
    toppedUp: cny.topped_up_balance,
  }
}

/** 服务商 → 接口地址与模型名 */
function endpointOf(p: Provider): { url: string; model: string } {
  if (p === 'doubao') return { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: getDoubaoEndpoint() }
  if (p === 'gemini') return { url: `${getGeminiBaseUrl()}/chat/completions`, model: getGeminiModel() }
  return { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' }
}

/** 对话补全（详细版）：返回正文和 token 用量，可指定服务商 */
export async function chatDetailed(
  messages: ChatMessage[],
  provider: Provider = getProvider(),
): Promise<{ text: string }> {
  const key = getApiKey(provider)
  if (!key) throw new Error('还没有填入密钥')

  const { url, model } = endpointOf(provider)
  if (provider === 'doubao' && !model) throw new Error('还没有填入豆包的接入点 ID')

  const res = await requestWithRetry(() =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        max_tokens: 1024,
        temperature: 1.1,
        // 豆包 seed 是深度思考模型：关掉 thinking，否则思考过程吃掉 token 导致正文为空
        ...(provider === 'doubao' ? { thinking: { type: 'disabled' } } : {}),
      }),
    }),
  )
  if (res.status === 401) throw new Error('密钥无效，请检查后再试')
  if (res.status === 402) throw new Error('余额不足啦，先去充一点～')
  if (res.status === 404 && provider === 'doubao') throw new Error('接入点 ID 不对，检查一下 ep- 开头那串')
  if (res.status === 404 && provider === 'gemini') throw new Error('模型名或接口地址不对，检查一下配置')
  if (!res.ok) throw new Error(`生成失败（${res.status}），稍后再试`)
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  if (provider === 'doubao') recordDoubaoUsage(data.usage)
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('这次没生成出内容，再发一次试试')
  return { text }
}

/** 流式对话补全：逐段回调增量文本，体感更快；返回完整文本 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (accumulated: string) => void,
  provider: Provider = getProvider(),
): Promise<string> {
  const key = getApiKey(provider)
  if (!key) throw new Error('还没有填入密钥')
  const { url, model } = endpointOf(provider)
  if (provider === 'doubao' && !model) throw new Error('还没有填入豆包的接入点 ID')

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 1024,
          temperature: 1.1,
          // 豆包 seed 是深度思考模型：关掉 thinking，否则正文迟迟不来且 token 被思考吃掉
          ...(provider === 'doubao' ? { thinking: { type: 'disabled' } } : {}),
        }),
      })
      if (res.status === 401) throw new Error('密钥无效，请检查后再试')
      if (res.status === 402) throw new Error('余额不足啦，先去充一点～')
      if (!res.ok || !res.body) {
        const err = new Error(`生成失败（${res.status}），稍后再试`) as Error & { status?: number }
        err.status = res.status
        throw err
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[]
              usage?: { prompt_tokens?: number; completion_tokens?: number }
            }
            const piece = json.choices?.[0]?.delta?.content
            if (piece) {
              acc += piece
              onDelta(acc)
            }
            if (provider === 'doubao' && json.usage) recordDoubaoUsage(json.usage)
          } catch {
            // 半行 JSON 留给下一轮
          }
        }
      }
      if (!acc.trim()) throw new Error('这次没生成出内容，再发一次试试')
      return acc
    } catch (e) {
      lastErr = e
      if (!isRetryable(e) || attempt === 2) break
      onDelta('') // 清掉半截文本，自动重试
      await sleep(900 * (attempt + 1))
    }
  }
  if (lastErr instanceof TypeError) {
    throw new Error('网络开小差了（可能切了后台或信号不稳），点「重试」再发一次')
  }
  throw lastErr
}

/** 对话补全：按当前服务商走对应官方接口（都是 OpenAI 兼容格式） */
export async function chatCompletion(messages: ChatMessage[], provider?: Provider): Promise<string> {
  return (await chatDetailed(messages, provider)).text
}
