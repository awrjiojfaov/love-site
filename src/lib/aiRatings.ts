/**
 * AI见闻打分生成器
 * 使用豆包API生成见闻打分内容
 */
import { isGuestSession } from './guest'
import { isDefaultSpace } from './space'

/* ---------- 空间隔离的本地标记（2026-10-03 修复）----------
 * 旧键 lastAIRatingDate / aiGeneratedRatings 没有 lovesite- 前缀，绕过了 space.ts
 * 的命名空间补丁：同一台设备上 A 组今天生成过 AI 见闻，B 组当天登录会被"已生成"挡住。
 * 新键带 lovesite- 前缀，由 space.ts 补丁自动按空间隔离；
 * 默认空间首读时把旧键的值一次性迁移过来（随后废弃旧键），避免老组当天重复生成。 */
const LS_LAST_DATE = 'lovesite-last-ai-rating-date'
const LS_MARKED = 'lovesite-ai-generated-ratings'

export function readLastAIRatingDate(): string | null {
  let v = localStorage.getItem(LS_LAST_DATE)
  if (v === null && isDefaultSpace()) {
    const legacy = localStorage.getItem('lastAIRatingDate')
    if (legacy !== null) {
      localStorage.setItem(LS_LAST_DATE, legacy)
      localStorage.removeItem('lastAIRatingDate')
      v = legacy
    }
  }
  return v
}

export function writeLastAIRatingDate(today: string): void {
  localStorage.setItem(LS_LAST_DATE, today)
}

function readMarkedRatings(): string {
  let raw = localStorage.getItem(LS_MARKED)
  if (raw === null && isDefaultSpace()) {
    const legacy = localStorage.getItem('aiGeneratedRatings')
    if (legacy !== null) {
      localStorage.setItem(LS_MARKED, legacy)
      localStorage.removeItem('aiGeneratedRatings')
      raw = legacy
    }
  }
  return raw ?? '[]'
}

// 已知的大分类
const CATEGORIES = [
  '花卉', '果蔬香草', '新增作物', '淡水鱼', '咸水鱼', '新增水产'
]



// AI生成见闻的提示词
const AI_PROMPT = `你是一只叫灰灰的长条狸花猫，现在为"秘密花园"情侣网站生成见闻打分内容。

要求：
1. 生成有趣的见闻描述，适合情侣打分
2. 内容要温馨、浪漫或有趣
3. 每条见闻包含标题和简短描述
4. 从以下分类中选择：${CATEGORIES.join('、')}
5. 不要重复生成相似内容

请返回JSON格式，包含：
- title: 见闻标题
- description: 见闻描述
- category: 大分类
- subCategory: 小分类（如果有的话）

示例：
{
  "title": "楼下的橘猫",
  "description": "今天在楼下遇到一只胖橘猫，它蹭我的腿还咕噜咕噜叫，好可爱！",
  "category": "新增作物",
  "subCategory": "多肉"
}`

// 豆包API配置
const DOUBAN_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
const DOUBAN_MODEL = 'deepseek-chat'

interface AIResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

interface RatingIdea {
  title: string
  description: string
  category: string
  subCategory: string
}

/**
 * 生成AI见闻打分内容
 * @param apiKey 豆包API密钥
 * @returns Promise<RatingIdea>
 */
export async function generateAIRating(apiKey?: string): Promise<RatingIdea | null> {
  if (isGuestSession()) {
    throw new Error('游客不能使用AI生成功能')
  }

  try {
    const response = await fetch(DOUBAN_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: DOUBAN_MODEL,
        messages: [
          {
            role: 'user',
            content: AI_PROMPT
          }
        ],
        temperature: 0.8,
        max_tokens: 1000,
        // 禁用深度思考模式，否则正文为空
        extra_body: {
          thinking: {
            type: 'disabled'
          }
        }
      })
    })

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`)
    }

    const data: AIResponse = await response.json()
    const content = data.choices[0]?.message?.content

    if (!content) {
      throw new Error('AI返回内容为空')
    }

    // 解析JSON响应
    const ideas: RatingIdea[] = JSON.parse(content)
    
    // 验证数据格式
    if (!Array.isArray(ideas) || ideas.length === 0) {
      throw new Error('AI返回格式错误，需要数组')
    }

    // 取第一个见闻
    const idea = ideas[0]
    
    // 验证数据
    if (!idea.title || !idea.description || !CATEGORIES.includes(idea.category)) {
      throw new Error('AI返回数据格式错误')
    }

    return idea
  } catch (error) {
    console.error('AI生成见闻失败:', error)
    throw error
  }
}

/**
 * 检查是否需要生成新的AI见闻（每天凌晨执行）
 * @param lastGenerated 上次生成时间
 * @returns boolean
 */
export function shouldGenerateAIRatings(lastGenerated: number): boolean {
  const now = Date.now()
  const today = new Date(now)
  const lastDate = new Date(lastGenerated)
  
  // 如果是不同日期，则需要生成
  return today.toDateString() !== lastDate.toDateString()
}

/**
 * 检查是否需要生成AI见闻（基于当前见闻数量）
 * @param currentRatings 当前见闻列表
 * @returns boolean
 */
export function shouldGenerateAIRating(currentRatings: any[]): boolean {
  const today = new Date().toDateString()
  const lastAIRatingDate = readLastAIRatingDate()

  // 如果今天已经生成过，则不需要
  if (lastAIRatingDate === today) return false
  
  // 如果见闻数量少于10条，则生成
  return currentRatings.length < 10
}

/**
 * 标记AI生成的见闻（用于管理员删除）
 */
export const AI_RATING_MARKER = 'ai_generated_by_huihui'

/**
 * 创建AI生成的见闻
 */
export function createAIRating(idea: RatingIdea): any {
  return {
    id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: idea.title,
    note: idea.description,
    ts: Date.now(),
    cat: idea.category,
    sub: idea.subCategory || '',
    createdBy: '灰灰',
    scores: {},
    comments: [],
    mts: Date.now(),
    [AI_RATING_MARKER]: true // 标记为AI生成
  }
}

/**
 * 标记见闻为AI生成（用于管理员删除）
 */
export function markForAdminDeletion(ratingId: string): void {
  try {
    const markedRatings = JSON.parse(readMarkedRatings())
    if (!markedRatings.includes(ratingId)) {
      markedRatings.push(ratingId)
      localStorage.setItem(LS_MARKED, JSON.stringify(markedRatings))
    }
  } catch (error) {
    console.error('标记AI生成见闻失败:', error)
  }
}

/**
 * 检查见闻是否为AI生成
 */
export function isAIRating(rating: any): boolean {
  return rating && rating[AI_RATING_MARKER] === true
}