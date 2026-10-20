import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import '@fontsource/ma-shan-zheng'
import './index.css'
import App from './App.tsx'

/**
 * 自动更新：把服务器上 index.html 里的入口脚本，和当前正在跑的这一份比对。
 * 不一致说明刚发了新版本 → 刷新一次，用户不用手动清缓存。
 * 每个会话只查一次（先打标记再刷新，避免新版又查一次造成死循环）。
 */
async function checkForUpdate(): Promise<void> {
  if (import.meta.env.DEV) return
  if (sessionStorage.getItem('lovesite-update-checked') === '1') return
  sessionStorage.setItem('lovesite-update-checked', '1')
  try {
    const self = new URL(import.meta.url).pathname.split('/').pop() // 例：index-BndsU0Lt.js
    const res = await fetch('./index.html', { cache: 'no-store' })
    if (!res.ok) return
    const html = await res.text()
    const m = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
    if (m && self && m[1] !== self) window.location.reload()
  } catch {
    // 网络抖动/离线：这次不查了，下次进来再说
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// 等首屏渲染完再查，别跟初始化抢资源
window.setTimeout(checkForUpdate, 6000)
