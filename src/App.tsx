import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Loader2, MoonStar } from 'lucide-react'
import SakuraCanvas from './components/SakuraCanvas'
import LoginPage, { getAllUsers, type User } from './sections/LoginPage'
import HomePage from './sections/HomePage'
import loginBg from './assets/login-bg.webp'
import { warmupSync } from './lib/warmup'
import { initCloudSync } from './lib/cloudSync'
import { subscribeLockdown, setGardenLocked as setGardenLockedCloud, GARDEN_KEEPER } from './lib/lockdown'
import { getSpaceId, setSpaceId } from './lib/space'
import { APP_TITLE, ICP } from './config'

// 功能页按需加载：主页秒开，进入时才下载对应代码
const RatingsPage = lazy(() => import('./sections/RatingsPage'))
const QuizPage = lazy(() => import('./sections/QuizPage'))
const AskPage = lazy(() => import('./sections/AskPage'))
const FarmPage = lazy(() => import('./sections/FarmPage'))
const RecordsPage = lazy(() => import('./sections/RecordsPage'))
const MapPage = lazy(() => import('./sections/MapPage'))
const WishShopPage = lazy(() => import('./sections/WishShopPage'))
const StoryPage = lazy(() => import('./sections/StoryPage'))
const MemoirPage = lazy(() => import('./sections/MemoirPage'))
const JarPage = lazy(() => import('./sections/JarPage'))
const BindingPage = lazy(() => import('./sections/BindingPage'))
const AdminPage = lazy(() => import('./sections/AdminPage'))
const WhisperPage = lazy(() => import('./sections/WhisperPage'))
const DrawGuessPage = lazy(() => import('./sections/DrawGuessPage'))
const JadePage = lazy(() => import('./sections/JadePage'))
const AuctionPage = lazy(() => import('./sections/AuctionPage'))
const StockPage = lazy(() => import('./sections/StockPage'))

/** 空闲时预载全部功能页代码：点开时无需再等下载 */
function preloadPages(): void {
  void import('./sections/RatingsPage')
  void import('./sections/QuizPage')
  void import('./sections/AskPage')
  void import('./sections/FarmPage')
  void import('./sections/RecordsPage')
  void import('./sections/MapPage')
  void import('./sections/WishShopPage')
  void import('./sections/StoryPage')
  void import('./sections/MemoirPage')
  void import('./sections/JarPage')
  void import('./sections/WhisperPage')
  void import('./sections/DrawGuessPage')
  void import('./sections/JadePage')
  void import('./sections/AuctionPage')
  void import('./sections/StockPage')
}

/** 空闲时预取大图（农场场景），点开不等图片 */
function preloadImages(): void {
  const urls = [
    new URL('./assets/farm-scene-portrait.webp', import.meta.url).href,
  ]
  urls.forEach((u) => {
    const img = new Image()
    img.src = u
  })
}

const SESSION_KEY = 'love-current-user'

type Page = 'home' | 'ratings' | 'quiz' | 'ask' | 'farm' | 'records' | 'map' | 'wishshop' | 'story' | 'memoir' | 'jar' | 'binding' | 'admin' | 'whisper' | 'drawguess' | 'jade' | 'auction' | 'stock'

function loadSession(): User | null {
  const name = localStorage.getItem(SESSION_KEY)
  if (!name) return null
  const found = Object.values(getAllUsers()).find((u) => u.name === name)
  return found || null
}



function PageLoader() {
  // 细长进度条：懒加载代码块下载期间平滑推进，页面替换 Suspense 时自然消失
  const [p, setP] = useState(14)
  useEffect(() => {
    const timers = [
      setTimeout(() => setP(42), 200),
      setTimeout(() => setP(68), 600),
      setTimeout(() => setP(88), 1200),
    ]
    return () => timers.forEach((t) => clearTimeout(t))
  }, [])
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-[#fff5f8] to-[#fae3ef]">
      <Loader2 className="h-7 w-7 animate-spin text-pink-300" />
      <div className="mt-5 h-1.5 w-44 overflow-hidden rounded-full bg-pink-100/80">
        <div
          className="h-full rounded-full bg-gradient-to-r from-pink-300 to-rose-400 transition-[width] duration-500 ease-out"
          style={{ width: `${p}%` }}
        />
      </div>
      <p className="mt-2.5 text-[11px] tracking-[0.3em] text-pink-300/80">加载中</p>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null>(loadSession())
  const [page, setPage] = useState<Page>('home')
  // 花园停用状态：停用后全站遮罩，只有成员B能解封
  const [gardenLocked, setGardenLocked] = useState(false)
  // 全屏启动封面：冷启动展示；进度条走完（封面图 + 字体真正就绪）后淡出
  const [splash, setSplash] = useState(true)
  const [splashOut, setSplashOut] = useState(false)
  /** 启动进度 0~100：5(挂载) + 27(入场动画) + 42(封面图解码) + 26(字体就绪) */
  const [progress, setProgress] = useState(5)
  const splashDoneRef = useRef(false)

  useEffect(() => {
    const t0 = performance.now()
    const weights = { boot: false, img: false, font: false }
    const target = () =>
      5 + (weights.boot ? 27 : 0) + (weights.img ? 42 : 0) + (weights.font ? 26 : 0)
    const finish = () => {
      if (splashDoneRef.current) return
      splashDoneRef.current = true
      const elapsed = performance.now() - t0
      // 最少展示 1.4s（防止快网络闪一下就没了），之后 0.8s 淡出
      const wait = Math.max(0, 1400 - elapsed)
      setTimeout(() => setSplashOut(true), wait)
      setTimeout(() => setSplash(false), wait + 800)
    }
    // 信号 ①：封面图解码完成（打包内 webp，正常几百毫秒；卡住也有兜底）
    const probe = new Image()
    probe.src = loginBg
    const markImg = () => { weights.img = true }
    if (typeof probe.decode === 'function') probe.decode().then(markImg, markImg)
    else markImg()
    setTimeout(markImg, 2200) // 兜底：图再慢也不无限吊着
    // 信号 ②：标题字体（Ma Shan Zheng）就绪
    const markFont = () => { weights.font = true }
    if (document.fonts?.ready) {
      const fontTimer = setTimeout(markFont, 2600)
      document.fonts.ready.then(() => { clearTimeout(fontTimer); markFont() })
    } else markFont()
    // 入场动画 + 进度推进：每拍向目标缓动，到 100 后走退场
    const id = setInterval(() => {
      const elapsed = performance.now() - t0
      if (!weights.boot && elapsed > 1100) weights.boot = true
      if (elapsed > 3200) { weights.boot = true; weights.img = true; weights.font = true }
      const tg = target()
      setProgress((v) => {
        if (v >= tg) { if (tg >= 100) finish(); return v }
        return Math.min(tg, v + Math.max(0.6, (tg - v) * 0.14))
      })
      if (weights.boot && weights.img && weights.font && performance.now() - t0 > 1400) finish()
    }, 90)
    return () => clearInterval(id)
  }, [])

  useEffect(() => subscribeLockdown((s) => setGardenLocked(s.locked)), [])

  // 登录后在后台预热：建立全部模块的云端订阅 + 空闲时预载页面代码和大图，
  // 之后点开任何功能页都是内存里的最新数据，秒开
  useEffect(() => {
    if (!user) return
    // 全量数据云同步先行：换浏览器/换设备登录时，把云端 retained 数据落回本地，
    // 再预热各模块订阅——剧情存档等本地-only 数据靠它恢复
    initCloudSync()
    warmupSync()
    const ric: (cb: () => void) => void =
      'requestIdleCallback' in window
        ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
        : (cb) => setTimeout(cb, 1500)
    ric(() => {
      preloadPages()
      preloadImages()
    })
  }, [user])

  const handleLogin = (u: User) => {
    const targetSpace = u.pairId ?? ''
    localStorage.setItem(SESSION_KEY, u.name)
    // 数据空间变化时整页重载：让所有模块的订阅/备份都落在正确的空间里
    if (targetSpace !== getSpaceId()) {
      setSpaceId(targetSpace)
      window.location.reload()
      return
    }
    setUser(u)
    setPage('home')
  }

  const handleCreateUser = () => {
    // 新账号组由管理员在后台直接创建并配对，使用者自行登录即可，无需跳转绑定页
    setPage('admin')
  }

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY)
    setUser(null)
    setPage('home')
  }



  return (
    <div className="mx-auto min-h-dvh max-w-md bg-white shadow-2xl sm:my-0">
      {!user ? (
        <LoginPage onLogin={handleLogin} />
      ) : (
        <Suspense fallback={<PageLoader />}>
          {page === 'ratings' ? (
            <RatingsPage user={user} onBack={() => setPage('home')} />
          ) : page === 'quiz' ? (
            <QuizPage user={user} onBack={() => setPage('home')} />
          ) : page === 'ask' ? (
            <AskPage user={user} onBack={() => setPage('home')} />
          ) : page === 'farm' ? (
            <FarmPage user={user} onBack={() => setPage('home')} />
          ) : page === 'records' ? (
            <RecordsPage user={user} onBack={() => setPage('home')} />
          ) : page === 'map' ? (
            <MapPage user={user} onBack={() => setPage('home')} />
          ) : page === 'wishshop' ? (
            <WishShopPage user={user} onBack={() => setPage('home')} />
          ) : page === 'story' ? (
            <StoryPage user={user} onBack={() => setPage('home')} />
          ) : page === 'memoir' ? (
            <MemoirPage user={user} onBack={() => setPage('home')} />
          ) : page === 'jar' ? (
            <JarPage user={user} onBack={() => setPage('home')} />
          ) : page === 'binding' ? (
            <BindingPage 
              user={user} 
              onBack={() => {setPage('home'); setUser(null); localStorage.removeItem(SESSION_KEY);}}
              onComplete={(finalUser) => {
                setUser(finalUser)
                setPage('home')
              }}
            />
          ) : page === 'admin' ? (
            <AdminPage user={user} onBack={() => setPage('home')} onCreateUser={handleCreateUser} />
          ) : page === 'whisper' ? (
            <WhisperPage user={user} onBack={() => setPage('home')} />
          ) : page === 'drawguess' ? (
            <DrawGuessPage user={user} onBack={() => setPage('home')} />
          ) : page === 'jade' ? (
            <JadePage user={user} onBack={() => setPage('home')} onOpenFarm={() => setPage('farm')} />
          ) : page === 'auction' ? (
            <AuctionPage user={user} onBack={() => setPage('home')} />
          ) : page === 'stock' ? (
            <StockPage user={user} onBack={() => setPage('home')} />
          ) : (
            <HomePage
              user={user}
              onLogout={handleLogout}
              onOpenRatings={() => setPage('ratings')}
              onOpenQuiz={() => setPage('quiz')}
              onOpenAsk={() => setPage('ask')}
              onOpenFarm={() => setPage('farm')}
              onOpenRecords={() => setPage('records')}
              onOpenMap={() => setPage('map')}
              onOpenWishShop={() => setPage('wishshop')}
              onOpenStory={() => setPage('story')}
              onOpenMemoir={() => setPage('memoir')}
              onOpenJar={() => setPage('jar')}
              onOpenWhisper={() => setPage('whisper')}
              onOpenDrawGuess={() => setPage('drawguess')}
              onOpenJade={() => setPage('jade')}
              onOpenAuction={() => setPage('auction')}
              onOpenStock={() => setPage('stock')}
              onOpenAdmin={() => setPage('admin')}
            />
          )}
        </Suspense>
      )}


      {/* 全屏启动封面：点开 app 先看到整屏封面，再淡入网站 */}
      {splash && (
        <div
          className={`fixed inset-0 z-[200] flex flex-col items-center justify-between overflow-hidden transition-opacity duration-700 ${
            splashOut ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <img
            src={loginBg}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/45" />
          <div className="relative z-10 mt-[16dvh] flex flex-col items-center">
            <p
              className="text-4xl tracking-[0.35em] text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.55)]"
              style={{ fontFamily: "'Ma Shan Zheng', 'STKaiti', 'KaiTi', cursive" }}
            >
              {APP_TITLE}
            </p>
            {/* 启动进度条：字体/封面图就绪后走满，封面才淡出 */}
            <div className="mt-10 h-1.5 w-44 overflow-hidden rounded-full bg-white/20 backdrop-blur-sm">
              <div
                className="h-full rounded-full bg-gradient-to-r from-rose-200 via-pink-300 to-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.75)] transition-[width] duration-200 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-2.5 text-[10px] tracking-[0.4em] text-white/60 [text-shadow:0_1px_4px_rgba(0,0,0,0.4)]">
              加载中
            </p>
          </div>
          {ICP && (
            <p className="relative z-10 mb-[10dvh] text-xs tracking-[0.3em] text-white/85 [text-shadow:0_1px_6px_rgba(0,0,0,0.5)]">
              {ICP}
            </p>
          )}
        </div>
      )}

      {/* 樱花只在登录页和主页飘落，功能页保持清爽 */}
      {(!user || page === 'home') && <SakuraCanvas />}

      {/* 花园歇园遮罩：停用期间挡住所有页面，仅管理员可解封 */}
      {user && gardenLocked && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-[#241a38] via-[#2e1f47] to-[#1b1229] px-10 text-center">
          <MoonStar className="mb-5 h-12 w-12 text-amber-200 drop-shadow-[0_0_18px_rgba(253,230,138,0.6)]" />
          <p
            className="text-xl tracking-[0.3em] text-pink-100"
            style={{ fontFamily: "'Ma Shan Zheng', 'STKaiti', 'KaiTi', cursive" }}
          >
            花园暂时关闭啦
          </p>
          <p className="mt-3 text-xs leading-relaxed tracking-widest text-pink-200/70">
            {user.name === GARDEN_KEEPER
              ? '你把花园关上啦，想回来的时候再打开～'
              : `${GARDEN_KEEPER}把花园关上了，等她回来开启～`}
          </p>
          {user.name === GARDEN_KEEPER && (
            <button
              onClick={() => setGardenLockedCloud(user.name, false)}
              className="mt-8 rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-8 py-3 text-sm font-bold tracking-[0.2em] text-white shadow-lg shadow-pink-500/30 transition-transform active:scale-95"
            >
              重新开门 🌸
            </button>
          )}
        </div>
      )}
    </div>
  )
}
