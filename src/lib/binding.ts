/**
 * 绑定码系统：让两个新用户通过绑定码配对，获得与默认用户相同的完整功能
 */

import { sharedPublish, sharedSubscribe } from './mqttClient'

const LS_KEY = 'lovesite-binding-code'

// 绑定状态
export type BindingState = {
  code: string
  paired: boolean
  partnerName?: string
  myName: string
  myPassword: string
}

// 生成随机6位数字绑定码
export function generateBindingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// 保存绑定码到本地存储
export function saveBindingCode(code: string): void {
  localStorage.setItem(LS_KEY, code)
}

// 获取当前绑定码
export function getCurrentBindingCode(): string | null {
  return localStorage.getItem(LS_KEY)
}

// 清除绑定码
export function clearBindingCode(): void {
  localStorage.removeItem(LS_KEY)
}

// 检查是否已绑定
export function isPaired(): boolean {
  const code = getCurrentBindingCode()
  if (!code) return false
  
  try {
    const state = JSON.parse(localStorage.getItem(`binding-${code}`) || '{}')
    return state.paired || false
  } catch {
    return false
  }
}

// 获取绑定状态
export function getBindingState(): BindingState | null {
  const code = getCurrentBindingCode()
  if (!code) return null
  
  try {
    const state = JSON.parse(localStorage.getItem(`binding-${code}`) || '{}')
    return state as BindingState
  } catch {
    return null
  }
}

// 创建新的绑定会话
export function createBindingSession(name: string, password: string): string {
  const code = generateBindingCode()
  const state: BindingState = {
    code,
    paired: false,
    myName: name,
    myPassword: password
  }
  
  localStorage.setItem(`binding-${code}`, JSON.stringify(state))
  saveBindingCode(code)
  
  // 发布绑定码到云端，让其他人可以搜索
  sharedPublish(`lovesite/binding/search/${code}`, JSON.stringify({
    code,
    name,
    timestamp: Date.now()
  }))
  
  return code
}

// 尝试配对绑定码
export async function pairBindingCode(code: string, myName: string, myPassword: string): Promise<{ success: boolean; message: string; partnerName?: string }> {
  // 检查绑定码格式
  if (!/^\d{6}$/.test(code)) {
    return { success: false, message: '绑定码格式不正确' }
  }
  
  // 检查是否已经绑定
  if (isPaired()) {
    return { success: false, message: '您已经绑定过了' }
  }
  
  try {
    // 查找绑定码对应的会话
    const state = localStorage.getItem(`binding-${code}`)
    if (!state) {
      return { success: false, message: '绑定码不存在或已过期' }
    }
    
    const bindingState = JSON.parse(state) as BindingState
    
    // 检查是否已经被配对
    if (bindingState.paired) {
      return { success: false, message: '该绑定码已经被配对' }
    }
    
    // 创建配对
    const pairedState: BindingState = {
      code,
      paired: true,
      partnerName: bindingState.myName,
      myName: myName,
      myPassword: myPassword
    }
    
    // 保存双方的绑定状态
    localStorage.setItem(`binding-${code}`, JSON.stringify(pairedState))
    localStorage.setItem(`binding-${code}-partner`, JSON.stringify({
      code,
      paired: true,
      partnerName: myName,
      myName: bindingState.myName,
      myPassword: bindingState.myPassword
    }))
    
    // 发布配对成功消息
    sharedPublish(`lovesite/binding/paired/${code}`, JSON.stringify({
      code,
      user1: bindingState.myName,
      user2: myName,
      timestamp: Date.now()
    }))
    
    return { 
      success: true, 
      message: '配对成功！', 
      partnerName: bindingState.myName 
    }
  } catch (error) {
    return { success: false, message: '配对失败，请重试' }
  }
}

// 订阅绑定配对事件
export function subscribeBindingPair(callback: (data: { code: string; user1: string; user2: string }) => void): () => void {
  return sharedSubscribe(`lovesite/binding/paired/+/`, (message) => {
    try {
      const data = JSON.parse(message.toString())
      callback(data)
    } catch (error) {
      console.error('Failed to parse binding pair message:', error)
    }
  })
}

// 订阅绑定码搜索事件
export function subscribeBindingSearch(callback: (data: { code: string; name: string; timestamp: number }) => void): () => void {
  return sharedSubscribe(`lovesite/binding/search/+/`, (message) => {
    try {
      const data = JSON.parse(message.toString())
      callback(data)
    } catch (error) {
      console.error('Failed to parse binding search message:', error)
    }
  })
}