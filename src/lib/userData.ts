/**
 * 用户数据初始化：为新绑定用户创建初始数据
 */

import { addTx } from './wallet'
import { generateBindingCode } from './binding'

// 创建默认用户数据
export function createDefaultUserData(name: string, password: string): any {
  // 创建用户对象
  const user = {
    name,
    password,
    theme: Math.random() > 0.5 ? 'pink' : 'blue' as 'pink' | 'blue',
    isDefault: false,
    bindingCode: generateBindingCode()
  }

  // 初始化各种数据
  const userData = {
    // 用户基本信息
    user,
    
    // 钱包：初始2000时元
    wallet: [
      // 确定性 id：绑定流程重复触发 / 两台设备各绑一次时只发一次，
      // 否则同一笔「初始时元」会入账两次（余额虚高，两台手机数字对不上）
      addTx(name, 2000, '初始时元', `init-coins-${name}`)
    ],
    
    // 农场：初始空数据
    farm: {
      plots: [],
      pond: [],
      warehouse: {},
      waterDay: new Date().toISOString().split('T')[0],
      waterCount: 0,
      tracking: [],
      dex: []
    },
    
    // 爱情树：初始0经验
    tree: {
      total: 0,
      daily: 0,
      lastDaily: Date.now(),
      unlocked: false,
      day: 0,
      dayBy: {},
      loginDay: 0,
      contrib: 0
    },
    
    // 见闻打分：初始空数据
    ratings: {
      items: [],
      categories: []
    },
    
    // 问答：初始空数据
    asks: [],
    
    // 纪念日盲盒：初始空数据
    blindbox: {
      available: [],
      history: []
    },
    
    // 心愿商店：初始空数据
    wish: {
      pending: [],
      history: []
    },
    
    // 礼物：初始空数据
    gifts: {
      sent: [],
      received: [],
      requests: []
    },
    
    // 花园状态：初始未锁定
    lockdown: {
      locked: false,
      lockedBy: '',
      lockedAt: 0,
      by: '',
      ts: 0
    },
    
    // 头像框：初始无框
    frames: {
      owned: {},
      equipped: {}
    },
    
    // 自定义头像：初始无
    avatars: {},
    
    // 存钱罐：初始空数据
    jar: [],
    
    // 回忆录：初始空数据
    memoir: {
      entries: []
    }
  }

  return userData
}

// 保存用户数据到localStorage
export function saveUserData(userData: any): void {
  const keys = [
    'love-user',
    'love-wallet',
    'love-farm',
    'love-tree',
    'love-ratings',
    'love-asks',
    'love-blindbox',
    'love-wish',
    'love-gifts',
    'love-lockdown',
    'love-frames',
    'love-avatars',
    'love-jar',
    'love-memoir'
  ]

  keys.forEach(key => {
    if (key === 'love-user') {
      localStorage.setItem(key, JSON.stringify(userData.user))
    } else {
      localStorage.setItem(key, JSON.stringify(userData[key.replace('love-', '')]))
    }
  })
}

// 加载用户数据
export function loadUserData(): any {
  const userData = {
    user: JSON.parse(localStorage.getItem('love-user') || '{}'),
    wallet: JSON.parse(localStorage.getItem('love-wallet') || '[]'),
    farm: JSON.parse(localStorage.getItem('love-farm') || '{}'),
    tree: JSON.parse(localStorage.getItem('love-tree') || '{}'),
    ratings: JSON.parse(localStorage.getItem('love-ratings') || '{}'),
    asks: JSON.parse(localStorage.getItem('love-asks') || '[]'),
    blindbox: JSON.parse(localStorage.getItem('love-blindbox') || '{}'),
    wish: JSON.parse(localStorage.getItem('love-wish') || '{}'),
    gifts: JSON.parse(localStorage.getItem('love-gifts') || '{}'),
    lockdown: JSON.parse(localStorage.getItem('love-lockdown') || '{}'),
    frames: JSON.parse(localStorage.getItem('love-frames') || '{}'),
    avatars: JSON.parse(localStorage.getItem('love-avatars') || '{}'),
    jar: JSON.parse(localStorage.getItem('love-jar') || '[]'),
    memoir: JSON.parse(localStorage.getItem('love-memoir') || '{}')
  }

  return userData
}

// 清除用户数据
export function clearUserData(): void {
  const keys = [
    'love-user',
    'love-wallet',
    'love-farm',
    'love-tree',
    'love-ratings',
    'love-asks',
    'love-blindbox',
    'love-wish',
    'love-gifts',
    'love-lockdown',
    'love-frames',
    'love-avatars',
    'love-jar',
    'love-memoir'
  ]

  keys.forEach(key => {
    localStorage.removeItem(key)
  })
}