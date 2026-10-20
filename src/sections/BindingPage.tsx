import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Check, CheckCircle, AlertCircle, Loader2, Key } from 'lucide-react'
import { generateBindingCode, saveBindingCode, getCurrentBindingCode, pairBindingCode, isPaired, getBindingState, subscribeBindingPair, clearBindingCode } from '../lib/binding'
import type { User } from './LoginPage'
import { createDefaultUserData, saveUserData } from '../lib/userData'
import { ADMIN_NAME, ADMIN_PASSWORD } from '../config'

export default function BindingPage({ 
  user, 
  onBack, 
  onComplete 
}: { 
  user: User 
  onBack: () => void 
  onComplete: (finalUser: User) => void 
}) {
  const [bindingCode, setBindingCode] = useState<string>('')
  const [inputCode, setInputCode] = useState<string>('')
  const [isCopied, setIsCopied] = useState(false)
  const [status, setStatus] = useState<'idle' | 'waiting' | 'pairing' | 'paired'>('idle')
  const [error, setError] = useState('')
  const [isManager, setIsManager] = useState(false) // 是否是管理员

  // 检查是否是管理员
  useEffect(() => {
    setIsManager(user.name === ADMIN_NAME && user.password === ADMIN_PASSWORD)
  }, [user.name, user.password])

  // 初始化绑定码
  useEffect(() => {
    const code = getCurrentBindingCode()
    if (code) {
      setBindingCode(code)
      setStatus('waiting')
      // 检查是否已经配对
      if (isPaired()) {
        const state = getBindingState()
        if (state?.partnerName) {
          setPartnerName(state.partnerName)
          setStatus('paired')
        }
      }
    } else {
      const newCode = generateBindingCode()
      setBindingCode(newCode)
      saveBindingCode(newCode)
      setStatus('waiting')
    }
  }, [])

  // 如果是管理员，检查是否有对应的用户绑定码
  useEffect(() => {
    if (isManager) {
      // 检查当前用户是否有绑定码
      const currentCode = getCurrentBindingCode()
      if (!currentCode) {
        // 如果没有，生成一个新的
        const newCode = generateBindingCode()
        setBindingCode(newCode)
        saveBindingCode(newCode)
        setStatus('waiting')
      }
    }
  }, [isManager])

  // 监听配对成功事件
  useEffect(() => {
    const unsubscribe = subscribeBindingPair((data) => {
      if (data.code === bindingCode && data.user2 === user.name) {
        setPartnerName(data.user1)
        setStatus('paired')
        
        // 创建完整的用户数据
        setTimeout(() => {
          const finalUser = createDefaultUserData(user.name, user.password || '')
          // 保存用户数据到localStorage
          saveUserData(finalUser)
          onComplete(finalUser)
        }, 1500)
      }
    })

    return () => unsubscribe()
  }, [bindingCode, user.name, user.password, onComplete])

  const handleCopyCode = () => {
    navigator.clipboard.writeText(bindingCode)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handlePair = async () => {
    if (!inputCode.trim()) {
      setError('请输入绑定码')
      return
    }

    setStatus('pairing')
    setError('')

    const result = await pairBindingCode(inputCode.trim(), user.name, user.password || '')
    
    if (result.success) {
      setStatus('paired')
      setPartnerName(result.partnerName || '')
      
      // 创建完整的用户数据
      setTimeout(() => {
        const finalUser = createDefaultUserData(user.name, user.password || '')
        // 保存用户数据到localStorage
        saveUserData(finalUser)
        onComplete(finalUser)
      }, 1500)
    } else {
      setStatus('waiting')
      setError(result.message)
    }
  }

  const handleGenerateNewCode = () => {
    const newCode = generateBindingCode()
    setBindingCode(newCode)
    saveBindingCode(newCode)
    setStatus('waiting')
    setError('')
  }

  const handleRestart = () => {
    clearBindingCode()
    onBack()
  }

  const [partnerName, setPartnerName] = useState<string>('')

  if (status === 'paired') {
    return (
      <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef] flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <CheckCircle className="h-20 w-20 text-green-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-[#c44d7d] mb-2">绑定成功！</h1>
            <p className="text-[#8a4a68]">欢迎来到秘密花园</p>
          </div>

          <div className="bg-white/90 rounded-3xl p-8 shadow-xl">
            <div className="flex items-center justify-center gap-4 mb-6">
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-pink-400 to-rose-400 flex items-center justify-center text-white font-bold text-lg mb-2">
                  {user.name.charAt(0)}
                </div>
                <p className="text-sm font-semibold text-[#c44d7d]">{user.name}</p>
              </div>
              
              <div className="flex flex-col items-center">
                <div className="w-12 h-1 bg-pink-300 rounded-full mb-1"></div>
                <span className="text-xs text-pink-400">与</span>
                <div className="w-12 h-1 bg-pink-300 rounded-full mt-1"></div>
              </div>
              
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-400 to-cyan-400 flex items-center justify-center text-white font-bold text-lg mb-2">
                  {partnerName.charAt(0)}
                </div>
                <p className="text-sm font-semibold text-[#c44d7d]">{partnerName}</p>
              </div>
            </div>

            <div className="text-center">
              <p className="text-lg font-semibold text-[#c44d7d] mb-2">初始时元：2000</p>
              <p className="text-sm text-pink-400 mb-6">开始你们的甜蜜之旅吧！</p>
              
              <div className="animate-pulse">
                <Loader2 className="h-6 w-6 text-pink-400 mx-auto mb-2" />
                <p className="text-xs text-pink-400">正在进入主页...</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef] flex flex-col">
      {/* 顶部导航 */}
      <div className="sticky top-0 z-10 flex items-center gap-4 bg-gradient-to-b from-[#fff5f8] via-[#fff5f8]/95 p-6 pb-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-pink-300 transition-colors active:text-pink-500"
        >
          <ArrowLeft className="h-5 w-5" />
          返回
        </button>
        <h1 className="text-xl font-bold text-[#c44d7d]">绑定账号</h1>
        {isManager && (
          <span className="text-xs bg-purple-100 text-purple-600 px-2 py-1 rounded-full">管理员模式</span>
        )}
      </div>

      {/* 主要内容 */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="bg-white/90 rounded-3xl p-8 shadow-xl">
            {status === 'waiting' && (
              <div className="text-center mb-8">
                <h2 className="text-xl font-bold text-[#c44d7d] mb-4">
                  {isManager ? '生成绑定码' : '等待配对'}
                </h2>
                
                <div className="bg-gradient-to-r from-pink-50 to-rose-50 rounded-2xl p-6 mb-6">
                  <div className="flex items-center justify-center gap-3 mb-2">
                    <Key className="h-5 w-5 text-purple-500" />
                    <p className="text-sm text-purple-400">绑定码</p>
                  </div>
                  <div className="text-4xl font-bold tracking-widest text-[#c44d7d] tabular-nums">
                    {bindingCode}
                  </div>
                </div>

                {isManager ? (
                  <div className="space-y-4">
                    <p className="text-[#8a4a68] mb-4">
                      将此绑定码告诉需要绑定的用户，对方输入相同码即可配对成功
                    </p>
                    <button
                      onClick={handleCopyCode}
                      className="w-full rounded-2xl bg-purple-100 text-purple-600 font-medium py-3 transition-all active:bg-purple-200 flex items-center justify-center gap-2"
                    >
                      {isCopied ? (
                        <>
                          <Check className="h-5 w-5" />
                          已复制到剪贴板
                        </>
                      ) : (
                        <>
                          <Copy className="h-5 w-5" />
                          复制绑定码
                        </>
                      )}
                    </button>
                    <button
                      onClick={handleGenerateNewCode}
                      className="w-full rounded-2xl bg-gray-100 text-gray-600 font-medium py-3 transition-all active:bg-gray-200"
                    >
                      生成新绑定码
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-[#8a4a68] mb-6">
                      请将绑定码告诉对方，让对方输入此码完成配对
                    </p>
                    <button
                      onClick={handleCopyCode}
                      className="w-full rounded-2xl bg-purple-100 text-purple-600 font-medium py-3 transition-all active:bg-purple-200 flex items-center justify-center gap-2"
                    >
                      {isCopied ? (
                        <>
                          <Check className="h-5 w-5" />
                          已复制到剪贴板
                        </>
                      ) : (
                        <>
                          <Copy className="h-5 w-5" />
                          复制绑定码
                        </>
                      )}
                    </button>
                    <p className="text-xs text-pink-400 mt-4">请记住此绑定码，配对成功后将无法更改</p>
                  </>
                )}
              </div>
            )}

            {status === 'pairing' && (
              <div className="text-center">
                <Loader2 className="h-8 w-8 animate-spin text-pink-400 mx-auto mb-4" />
                <p className="text-[#8a4a68]">正在配对中...</p>
              </div>
            )}

            {!isManager && (
              <>
                {/* 输入对方绑定码 */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-[#c44d7d] mb-4 text-center">或输入对方绑定码</h3>
                  <div className="flex gap-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={inputCode}
                      onChange={(e) => setInputCode(e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="输入6位绑定码"
                      className="flex-1 rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 text-center text-lg tracking-[0.4em] text-[#8a4a68] outline-none placeholder:text-sm placeholder:tracking-normal placeholder:text-pink-300 focus:border-pink-400 focus:bg-white"
                    />
                    <button
                      onClick={handlePair}
                      disabled={status === 'pairing'}
                      className="px-6 rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 text-white font-semibold shadow-lg shadow-pink-200 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {status === 'pairing' ? <Loader2 className="h-4 w-4 animate-spin" /> : '配对'}
                    </button>
                  </div>
                  
                  {error && (
                    <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3">
                      <AlertCircle className="h-4 w-4 text-red-400" />
                      <p className="text-sm text-red-400">{error}</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* 重新开始 */}
            <div className="mt-8 text-center">
              <button
                onClick={handleRestart}
                className="text-sm text-pink-300 hover:text-pink-500 transition-colors"
              >
                重新开始
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 底部提示 */}
      <div className="p-6 text-center">
        <p className="text-xs text-pink-300">
          {isManager 
            ? '绑定成功后，用户将拥有独立的花园数据，初始时元为2000' 
            : '绑定成功后，你们将拥有独立的花园数据，初始时元为2000'
          }
        </p>
      </div>
    </div>
  )
}