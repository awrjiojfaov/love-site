import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, Trash2, Users, Gem, Eye, EyeOff } from 'lucide-react'
import type { User } from './LoginPage'
import { DEFAULT_USERS } from './LoginPage'
import {
  createPair,
  getRegistry,
  removePair,
  subscribeRegistry,
  setUserHidden,
  setGlobalHidden,
  type Registry,
} from '../lib/registry'
import { seedStones } from '../lib/jade'
import { ADMIN_NAME, ADMIN_PASSWORD, MEMBER_A, MEMBER_B } from '../config'

/** 小开关：用于隐藏页面总开关与逐账号权限 */
function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? 'bg-gradient-to-r from-purple-400 to-pink-400' : 'bg-gray-300'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          on ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

export default function AdminPage({ user, onBack }: { user: User; onBack: () => void; onCreateUser?: (user: User) => void }) {
  const [registry, setRegistry] = useState<Registry>(getRegistry())
  const [name1, setName1] = useState('')
  const [pwd1, setPwd1] = useState('')
  const [name2, setName2] = useState('')
  const [pwd2, setPwd2] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)

  useEffect(() => subscribeRegistry((r) => setRegistry({ ...r })), [])

  const isDefaultAdmin = user.name === ADMIN_NAME && user.password === ADMIN_PASSWORD

  if (!isDefaultAdmin) {
    return (
      <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef] flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <AlertCircle className="h-16 w-16 text-red-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-[#c44d7d] mb-2">访问权限</h1>
          <p className="text-[#8a4a68] mb-6">只有{ADMIN_NAME}账号可以查看管理信息</p>
          <button
            onClick={onBack}
            className="rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-6 py-2 text-white font-medium shadow-lg shadow-pink-200 transition-all active:scale-95"
          >
            返回
          </button>
        </div>
      </div>
    )
  }

  const allNames = new Set([
    ...Object.values(DEFAULT_USERS).map((u) => u.name),
    ...Object.keys(registry.users),
  ])

  const handleCreatePair = () => {
    const n1 = name1.trim()
    const n2 = name2.trim()
    const p1 = pwd1.trim()
    const p2 = pwd2.trim()
    if (!n1 || !p1 || !n2 || !p2) {
      alert('请填写两位使用者的账号名称和密码')
      return
    }
    if (n1 === n2) {
      alert('两个账号名称不能相同')
      return
    }
    if (allNames.has(n1) || allNames.has(n2)) {
      alert('账号名称已存在，请换一个')
      return
    }
    createPair(n1, p1, n2, p2)
    setName1('')
    setPwd1('')
    setName2('')
    setPwd2('')
    setShowCreateForm(false)
    alert(`账号组创建成功！\n\n「${n1}」密码 ${p1}\n「${n2}」密码 ${p2}\n\n两人各自在登录页输入账号名称+密码即可进入属于他们的独立花园，数据从空白开始、与其他账号完全隔离。`)
  }

  const handleDeletePair = (pairId: string, members: string[]) => {
    if (confirm(`确定删除账号组「${members.join(' & ')}」吗？\n两人将无法再登录（他们的花园数据会保留在云端原空间中，但入口关闭）。`)) {
      removePair(pairId)
    }
  }

  const handleSeedJade = () => {
    if (confirm(`确定给「${ADMIN_NAME}」账号送上 20 块帝王料吗？`)) {
      const r = seedStones(ADMIN_NAME, 't4', 20)
      alert(r.msg)
    }
  }

  const pairs = Object.values(registry.pairs).sort((a, b) => b.createdAt - a.createdAt)
  const hiddenOn = registry.config?.hiddenPages !== false

  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef]">
      {/* 顶部栏 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#fff5f8]/90 px-5 pb-3 pt-6 backdrop-blur">
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#c44d7d] shadow transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold tracking-widest text-[#c44d7d]">账号管理</h1>
          <p className="text-xs text-pink-300">{ADMIN_NAME}专属管理页面</p>
        </div>
      </div>

      <div className="mx-auto max-w-md px-5 pb-16">
        {/* 隐藏页面设置（本节同时管理总开关与逐账号权限） */}
        <div className="mb-6 rounded-3xl bg-white p-6 shadow-lg shadow-pink-100">
          <div className="mb-4 flex items-center gap-2">
            {hiddenOn ? (
              <Eye className="h-4 w-4 text-purple-400" />
            ) : (
              <EyeOff className="h-4 w-4 text-gray-400" />
            )}
            <h2 className="text-lg font-bold text-[#c44d7d]">隐藏页面设置</h2>
          </div>

          <div className="flex items-center justify-between rounded-2xl bg-purple-50 p-3">
            <div className="pr-3">
              <p className="text-sm font-medium text-[#8a4a68]">启用隐藏页面</p>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-400">
                关闭后所有账号（含你们俩）都进不去隐藏页面
              </p>
            </div>
            <Toggle on={hiddenOn} onChange={(v) => setGlobalHidden(user.name, v)} />
          </div>

          <p className="mt-3 text-xs leading-relaxed text-pink-300">
            下面每个账号的开关控制「别人」能不能打开隐藏页面；新建账号默认开启。
          </p>
        </div>

        {/* 创建账号组按钮 */}
        <div className="mb-6">
          <button
            onClick={() => setShowCreateForm(true)}
            className="w-full rounded-3xl bg-gradient-to-r from-purple-400 to-pink-400 p-4 text-white font-bold shadow-lg shadow-purple-200 transition-all active:scale-95 flex items-center justify-center gap-2"
          >
            <Users className="h-5 w-5" />
            创建双人账号组
          </button>
        </div>

        {/* 玉石补发 */}
        <div className="mb-6">
          <button
            onClick={handleSeedJade}
            className="w-full rounded-3xl bg-gradient-to-r from-emerald-500 to-teal-500 p-4 text-white font-bold shadow-lg shadow-emerald-200 transition-all active:scale-95 flex items-center justify-center gap-2"
          >
            <Gem className="h-5 w-5" />
            给{ADMIN_NAME}送 20 块帝王料
          </button>
        </div>

        {/* 创建账号组表单 */}
        {showCreateForm && (
          <div className="mb-6 rounded-3xl bg-white p-6 shadow-lg shadow-pink-100">
            <h2 className="text-lg font-bold text-[#c44d7d] mb-4">创建双人账号组</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#8a4a68] mb-2">账号 1 名称</label>
                <input
                  type="text"
                  value={name1}
                  onChange={(e) => setName1(e.target.value)}
                  placeholder="输入第一个账号名称"
                  className="w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 text-[#8a4a68] outline-none placeholder:text-sm placeholder:text-pink-300 focus:border-pink-400 focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#8a4a68] mb-2">账号 1 密码</label>
                <input
                  type="text"
                  value={pwd1}
                  onChange={(e) => setPwd1(e.target.value)}
                  placeholder="输入第一个账号密码"
                  className="w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 text-[#8a4a68] outline-none placeholder:text-sm placeholder:text-pink-300 focus:border-pink-400 focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#8a4a68] mb-2">账号 2 名称</label>
                <input
                  type="text"
                  value={name2}
                  onChange={(e) => setName2(e.target.value)}
                  placeholder="输入第二个账号名称"
                  className="w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 text-[#8a4a68] outline-none placeholder:text-sm placeholder:text-pink-300 focus:border-pink-400 focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#8a4a68] mb-2">账号 2 密码</label>
                <input
                  type="text"
                  value={pwd2}
                  onChange={(e) => setPwd2(e.target.value)}
                  placeholder="输入第二个账号密码"
                  className="w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 text-[#8a4a68] outline-none placeholder:text-sm placeholder:text-pink-300 focus:border-pink-400 focus:bg-white"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleCreatePair}
                  className="flex-1 rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-white font-semibold shadow-lg shadow-pink-200 transition-all active:scale-95"
                >
                  创建
                </button>
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="flex-1 rounded-2xl bg-gray-100 py-3 text-gray-600 font-medium transition-all active:bg-gray-200"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 默认账号 */}
        <div className="mb-6 rounded-3xl bg-white p-6 shadow-lg shadow-pink-100">
          <h2 className="text-lg font-bold text-[#c44d7d] mb-4">默认账号组</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-2xl bg-gray-50 p-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-pink-400 to-rose-400 flex items-center justify-center text-white text-sm font-bold">
                  {MEMBER_A.slice(0, 1)}
                </div>
                <div>
                  <p className="text-sm font-medium text-[#8a4a68]">{MEMBER_A}</p>
                  <p className="text-xs text-gray-400">默认账号</p>
                </div>
              </div>
              <span className="text-xs text-gray-400">完整功能</span>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-gray-50 p-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-cyan-400 flex items-center justify-center text-white text-sm font-bold">
                  {MEMBER_B.slice(0, 1)}
                </div>
                <div>
                  <p className="text-sm font-medium text-[#8a4a68]">{MEMBER_B}</p>
                  <p className="text-xs text-gray-400">默认账号 · 管理员</p>
                </div>
              </div>
              <span className="text-xs text-gray-400">完整功能 + 管理</span>
            </div>
          </div>
        </div>

        {/* 账号组列表 */}
        <div className="rounded-3xl bg-white p-6 shadow-lg shadow-pink-100">
          <h2 className="text-lg font-bold text-[#c44d7d] mb-4">已创建的账号组</h2>

          <div className="space-y-3">
            {pairs.map((p) => (
              <div key={p.id} className="rounded-2xl border border-pink-100 bg-white p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-pink-400 flex items-center justify-center text-white text-sm font-bold">
                      {p.members[0]?.charAt(0) ?? '?'}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#8a4a68]">
                        {p.members[0]} <span className="text-pink-300">&</span> {p.members[1]}
                      </p>
                      <p className="text-xs text-gray-400">
                        创建于 {new Date(p.createdAt).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeletePair(p.id, p.members)}
                    className="text-xs text-red-400 hover:text-red-600 transition-colors flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" />
                    删除
                  </button>
                </div>
                <div className="mt-2 rounded-xl bg-purple-50 px-3 py-2 text-xs text-purple-600">
                  {p.members.map((m) => {
                    const ru = registry.users[m]
                    return (
                      <div key={m} className="flex justify-between">
                        <span>{m}</span>
                        <span className="font-mono">密码 {ru?.password ?? '—'}</span>
                      </div>
                    )
                  })}
                </div>

                {/* 逐账号隐藏页面权限 */}
                <div className="mt-2 space-y-2">
                  {p.members.map((m) => {
                    const allow = registry.users[m]?.allowHidden !== false
                    return (
                      <div
                        key={m}
                        className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2"
                      >
                        <span className="text-xs text-[#8a4a68]">
                          {m} · 隐藏页面权限
                        </span>
                        <Toggle
                          on={allow}
                          disabled={!hiddenOn}
                          onChange={(v) => setUserHidden(user.name, m, v)}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {pairs.length === 0 && (
            <p className="text-center text-sm text-pink-300 mt-2">暂无账号组</p>
          )}
        </div>

        {/* 使用说明 */}
        <div className="mt-6 rounded-3xl bg-pink-50 p-4">
          <h3 className="text-sm font-bold text-[#c44d7d] mb-2">使用说明</h3>
          <ul className="text-xs text-[#8a4a68] space-y-1">
            <li>• 点「创建双人账号组」，一次建好配对好的两个账号</li>
            <li>• 把账号名称和密码分别告诉两位使用者即可</li>
            <li>• 使用者在登录页输入账号名称 + 密码直接登录，无需注册</li>
            <li>• 每组账号拥有一套全新空白、完全独立的花园数据</li>
            <li>• 各组之间数据互不干扰，功能与你们的花园完全一致</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
