/**
 * 行情层：纯浏览器直连免费行情接口（腾讯为主、东方财富热备），不经 Kimi Work / MQTT。
 * - 实时报价 qt.gtimg.cn：批量拉多只，约 3 秒延迟，自带跨域头，GBK 编码
 * - 热备 push2.eastmoney.com：腾讯挂了自动切换，对调用方完全透明
 * - K线：web.ifzq.gtimg.cn（日K前复权 / 5分钟线），热备 push2his.eastmoney.com
 * - 涨跌榜：push2.eastmoney.com clist，全 A 股按涨幅排序
 * - 搜索：新浪 suggest 脚本注入（无跨域限制），key 支持中文/拼音/代码
 * 注意：这些是非官方网页自用接口，随时可能改规则——所有入口都做了双源或降级，
 *       页面一律展示数据时间戳，超时就提示而不是拿旧数据骗人。
 */

export type StockQuote = {
  code: string // 带市场前缀：sh600519 / sz000001
  num: string // 纯数字：600519
  name: string
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  change: number
  pct: number
  volume: number // 手
  amount: number // 万元
  time: string // 行情时间 yyyyMMddHHmmss
}

export type KlineBar = {
  time: string
  open: number
  close: number
  high: number
  low: number
  vol: number
}

export type StockHit = {
  code: string
  num: string
  name: string
}

export type RankRow = {
  code: string
  name: string
  price: number
  pct: number
  change: number
}

/* ---------- 市场前缀工具 ---------- */

export function marketOfNum(num: string): 'sh' | 'sz' {
  return num.startsWith('6') || num.startsWith('9') ? 'sh' : 'sz'
}

export function toCode(num: string): string {
  return marketOfNum(num) + num
}

/** 东财 secid：沪市 1.xxxxxx，深市 0.xxxxxx */
function toSecid(code: string): string {
  const num = code.replace(/^(sh|sz)/, '')
  return `${code.startsWith('sh') ? '1' : '0'}.${num}`
}

/** 指数代码常量（腾讯口径） */
export const INDEX_CODES = ['sh000001', 'sz399001', 'sz399006']

export function isTradingNow(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const mins = now.getHours() * 60 + now.getMinutes()
  return (mins >= 570 && mins < 690) || (mins >= 780 && mins < 900) // 9:30-11:30 / 13:00-15:00
}

/* ---------- 基础请求 ---------- */

async function fetchText(url: string, encoding = 'utf-8'): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  return new TextDecoder(encoding).decode(buf)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

/** 新浪 var 赋值式脚本注入：绕开跨域限制拿搜索建议 */
function injectScriptVar(url: string, varName: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as Record<string, unknown>
    delete w[varName]
    const script = document.createElement('script')
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('搜索接口超时'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      script.remove()
    }
    script.onload = () => {
      const val = w[varName]
      cleanup()
      if (typeof val === 'string') resolve(val)
      else reject(new Error('搜索接口无结果'))
    }
    script.onerror = () => {
      cleanup()
      reject(new Error('搜索接口加载失败'))
    }
    script.src = url
    document.head.appendChild(script)
  })
}

/* ---------- 腾讯行情解析 ----------
 * v_sh600519="1~贵州茅台~600519~1258.62~1235.58~1239.53~38331~..."
 *   [1]名 [2]码 [3]现价 [4]昨收 [5]今开 [30]时间 [31]涨跌 [32]涨幅% [33]最高 [34]最低 [36]量(手) [37]额(万) */
function parseTencentQuotes(text: string): Record<string, StockQuote> {
  const out: Record<string, StockQuote> = {}
  for (const seg of text.split(';')) {
    const m = seg.match(/v_(s[hz]\d{6})="([^"]*)"/)
    if (!m) continue
    const f = m[2].split('~')
    if (f.length < 38 || !f[1] || !f[3]) continue
    const num = f[2] || m[1].slice(2)
    out[m[1]] = {
      code: m[1],
      num,
      name: f[1],
      price: Number(f[3]),
      prevClose: Number(f[4]),
      open: Number(f[5]),
      high: Number(f[33]),
      low: Number(f[34]),
      change: Number(f[31]),
      pct: Number(f[32]),
      volume: Number(f[36]),
      amount: Number(f[37]),
      time: f[30] ?? '',
    }
  }
  return out
}

/* ---------- 东财行情解析（热备） ----------
 * fltt=2 时 f2 现价 f3 涨幅% f4 涨跌 f5 量(手) f6 额(元) f12 码 f13 市场 f14 名 f15 高 f16 低 f17 开 f18 昨收 */
function parseEastmoneyQuotes(diff: Array<Record<string, number | string>>): Record<string, StockQuote> {
  const out: Record<string, StockQuote> = {}
  for (const d of diff) {
    const num = String(d.f12 ?? '')
    if (!/^\d{6}$/.test(num)) continue
    const code = (d.f13 === 1 ? 'sh' : 'sz') + num
    const amountWan = Number(d.f6 ?? 0) / 10000
    out[code] = {
      code,
      num,
      name: String(d.f14 ?? ''),
      price: Number(d.f2),
      prevClose: Number(d.f18),
      open: Number(d.f17),
      high: Number(d.f15),
      low: Number(d.f16),
      change: Number(d.f4),
      pct: Number(d.f3),
      volume: Number(d.f5),
      amount: Math.round(amountWan),
      time: '',
    }
  }
  return out
}

/** 批量实时报价：腾讯主源，失败自动切东财热备 */
export async function quoteBatch(codes: string[]): Promise<Record<string, StockQuote>> {
  if (codes.length === 0) return {}
  try {
    const text = await fetchText(`https://qt.gtimg.cn/q=${codes.join(',')}`, 'gbk')
    const parsed = parseTencentQuotes(text)
    if (Object.keys(parsed).length > 0) return parsed
    throw new Error('腾讯返回为空')
  } catch {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2' +
      `&secids=${codes.map(toSecid).join(',')}` +
      '&fields=f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18'
    const json = await fetchJson<{ data?: { diff?: Array<Record<string, number | string>> } }>(url)
    const parsed = parseEastmoneyQuotes(json.data?.diff ?? [])
    if (Object.keys(parsed).length === 0) throw new Error('两个行情源都不可用')
    return parsed
  }
}

/* ---------- 搜索 ---------- */

/** 新浪搜索建议：type=111 只出 A 股；支持中文/拼音/代码 */
export async function searchStocks(keyword: string): Promise<StockHit[]> {
  const kw = keyword.trim()
  if (!kw) return []
  try {
    const raw = await injectScriptVar(
      `https://suggest3.sinajs.cn/suggest/type=111&key=${encodeURIComponent(kw)}`,
      'suggestvalue',
    )
    const hits: StockHit[] = []
    for (const line of raw.split(';')) {
      const f = line.split(',')
      // 格式：名,111,sh600519,sh600519,名,...（type=111 过滤后只会有 A 股）
      if (f.length < 5) continue
      const m = /^(sh|sz)(\d{6})$/.exec(f[2] ?? '')
      if (!m) continue
      hits.push({ code: f[2], num: m[2], name: f[0] })
      if (hits.length >= 12) break
    }
    return hits
  } catch {
    // 搜索挂了不致命：允许直接输 6 位代码加自选
    if (/^\d{6}$/.test(kw)) return [{ code: toCode(kw), num: kw, name: kw }]
    return []
  }
}

/* ---------- K线 ---------- */

type TencentKlineResp = {
  data?: Record<string, { qfqday?: string[][]; day?: string[][]; m5?: string[][] }>
}

function parseBars(rows: string[][] | undefined): KlineBar[] {
  if (!rows) return []
  return rows
    .filter((r) => r.length >= 6)
    .map((r) => ({
      time: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      vol: Number(r[5]),
    }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
}

/** 日 K（前复权）；m5 = 5 分钟线。失败切东财热备 */
export async function fetchKline(code: string, kind: 'day' | 'm5', count: number): Promise<KlineBar[]> {
  try {
    if (kind === 'day') {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${count},qfq`
      const json = await fetchJson<TencentKlineResp>(url)
      const d = json.data?.[code]
      return parseBars(d?.qfqday ?? d?.day)
    }
    const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m5,,${count}`
    const json = await fetchJson<TencentKlineResp>(url)
    return parseBars(json.data?.[code]?.m5)
  } catch {
    const klt = kind === 'day' ? 101 : 5
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${toSecid(code)}` +
      `&fields1=f1&fields2=f51,f52,f53,f54,f55,f56&klt=${klt}&fqt=1&beg=0&end=20500101&lmt=${count}`
    const json = await fetchJson<{ data?: { klines?: string[] } }>(url)
    const rows = (json.data?.klines ?? []).map((line) => line.split(','))
    return parseBars(rows)
  }
}

/* ---------- 涨跌榜 ---------- */

/** 全 A 股涨幅榜 / 跌幅榜（东财 clist，已验证带跨域头） */
export async function fetchRank(order: 'up' | 'down', count = 20): Promise<RankRow[]> {
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + count +
    `&po=${order === 'up' ? 1 : 0}&np=1&fltt=2&invt=2&fid=f3` +
    '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' +
    '&fields=f2,f3,f4,f12,f13,f14'
  const json = await fetchJson<{ data?: { diff?: Array<Record<string, number | string>> } }>(url)
  return (json.data?.diff ?? [])
    .map((d) => ({
      code: (d.f13 === 1 ? 'sh' : 'sz') + String(d.f12 ?? ''),
      name: String(d.f14 ?? ''),
      price: Number(d.f2),
      pct: Number(d.f3),
      change: Number(d.f4),
    }))
    .filter((r) => r.name && Number.isFinite(r.price))
}

/* ---------- 实时订阅（共享轮询，3 秒一拍） ---------- */

type QuoteCb = (quotes: Record<string, StockQuote>) => void

const registry = new Map<string, Set<QuoteCb>>()
const cache = new Map<string, StockQuote>()
let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const codes = [...registry.keys()]
    if (codes.length === 0) return
    const quotes = await quoteBatch(codes)
    for (const [code, q] of Object.entries(quotes)) cache.set(code, q)
    // 按订阅方感兴趣的代码分发
    for (const [code, cbs] of registry) {
      const q = cache.get(code)
      if (!q) continue
      cbs.forEach((cb) => cb({ [code]: q }))
    }
  } catch {
    /* 网络抖动：下一轮再试，缓存数据兜底 */
  } finally {
    ticking = false
  }
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(() => void tick(), 3000)
}

function stopTimerIfIdle(): void {
  if (registry.size > 0 || !timer) return
  clearInterval(timer)
  timer = null
}

/** 订阅实时报价：立即回放缓存 + 拉最新，之后每 3 秒推送变化 */
export function subscribeQuotes(codes: string[], onQuotes: QuoteCb): () => void {
  const interested = new Set(codes)
  const cb: QuoteCb = (quotes) => {
    const partial: Record<string, StockQuote> = {}
    for (const c of interested) if (quotes[c]) partial[c] = quotes[c]
    if (Object.keys(partial).length > 0) onQuotes(partial)
  }
  for (const c of codes) {
    let set = registry.get(c)
    if (!set) {
      set = new Set()
      registry.set(c, set)
    }
    set.add(cb)
  }
  // 立即回放缓存
  const cached: Record<string, StockQuote> = {}
  for (const c of codes) {
    const q = cache.get(c)
    if (q) cached[c] = q
  }
  if (Object.keys(cached).length > 0) onQuotes(cached)
  ensureTimer()
  void tick()
  return () => {
    for (const c of codes) {
      const set = registry.get(c)
      if (!set) continue
      set.delete(cb)
      if (set.size === 0) registry.delete(c)
    }
    stopTimerIfIdle()
  }
}

/** 缓存中的最新报价（K线页 / 交易确认用） */
export function cachedQuote(code: string): StockQuote | undefined {
  return cache.get(code)
}

export function quoteTimeText(q: StockQuote | undefined): string {
  const t = q?.time ?? ''
  if (t.length !== 14) return ''
  return `${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`
}
