/**
 * 集成测试：提纯剂改农场合成 + 10 只拉满 + 每日打卡（2026-10-10 第三批）
 * 用 esbuild 打包真实 jade.ts / farm.ts，桩掉 mqtt / wallet / guest / space / tree。
 * 跑法：node tools/_itest_purify2.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const stubDir = path.join(os.tmpdir(), 'jadetest')
const outDir = path.join(root, 'node_modules/.cache/itest2')
mkdirSync(outDir, { recursive: true })

const P = (p) => path.join(root, p).replace(/\\/g, '/')
writeFileSync(path.join(outDir, 'entry.ts'), `
export * from '${P('src/lib/jade.ts')}'
export * as farm from '${P('src/lib/farm.ts')}'
`)

/** 把 farm.ts / jade.ts 里的相对依赖替换成测试桩 */
const stubPlugin = {
  name: 'stub-relative-deps',
  setup(b) {
    const map = {
      './mqttClient': `${stubDir}/stub-mqtt.ts`,
      './wallet': `${stubDir}/stub-wallet.ts`,
      './guest': `${stubDir}/stub-guest.ts`,
      './space': `${stubDir}/stub-space.ts`,
      './tree': `${stubDir}/stub-tree.ts`,
    }
    b.onResolve({ filter: /^\.\/(mqttClient|wallet|guest|space|tree)$/ }, (args) => {
      const hit = map[args.path]
      return hit ? { path: hit } : null
    })
  },
}

await build({
  entryPoints: [path.join(outDir, 'entry.ts')],
  bundle: true, format: 'esm', platform: 'node',
  outfile: path.join(outDir, 'bundle.mjs'),
  plugins: [stubPlugin],
  logLevel: 'warning',
})

const m = await import(pathToFileURL(path.join(outDir, 'bundle.mjs')).href)
const { farm } = m

let pass = 0, fail = 0
const ok = (c, n, extra = '') => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n} ${extra}`)) }
const section = (t) => console.log(`\n── ${t} ──`)

const WHO = '成员B'

// 读当前农场 map
let farmMap = {}
farm.subscribeFarm((f) => { farmMap = f })
const wh = () => farm.farmOf(farmMap, WHO).warehouse
// 等 ensureClient() 里的异步「云端已连接」回调跑完（cloudReady / cloudSynced 就绪）
await new Promise(r => setTimeout(r, 80))
// 触发一次 jade 侧初始化（懒启动）
m.subscribeJade(() => {})
await new Promise(r => setTimeout(r, 50))

// ───────── 1. 提纯剂配方 ─────────
section('1. 提纯剂合成线（硬核路径）')
const R = farm.RECIPES
const pzB = R.find(r => r.id === 'pz_basic')
const pzF = R.find(r => r.id === 'pz_fine')
const pzS = R.find(r => r.id === 'pz_supreme')
ok(!!pzB && !!pzF && !!pzS, '三条配方齐全 pz_basic / pz_fine / pz_supreme')
ok(pzB.mats.every(([id]) => !farm.isRareId(id) && !farm.isSeedId(id)), '草木剂只用普通作物')
ok(pzF.mats.some(([id]) => farm.isRareId(id)), '寒泉剂含仙品作物（x_）')
const fusionIds = farm.CROPS.filter(c => c.fusionOnly).map(c => c.id)
ok(pzS.mats.some(([id]) => fusionIds.includes(id)), '龙涎剂含特殊种子作物成品')
ok(pzS.mats.some(([id]) => id === 'x_moonberry'), '龙涎剂含融合作物的仙品')

// ───────── 2. 合出发提纯剂 ─────────
section('2. 合成 → 进提纯剂库存（不进仓库）')
// 用真实渠道把材料种进仓库：grantWarehouse 需要 cloudReady（桩已给）
farm.grantWarehouse(WHO, Object.fromEntries(pzB.mats.map(([id, n]) => [id, n])))
const b0 = m.reagentCountOf(WHO, 'basic')
const r1 = farm.synthesize(WHO, 'pz_basic')
const b1 = m.reagentCountOf(WHO, 'basic')
ok(r1.ok, `合成草木剂成功：${r1.msg}`)
ok(b1 === b0 + 1, `提纯剂库存 +1（${b0}→${b1}）`)
ok(!wh()['pz_basic'], '提纯剂不进仓库')
ok(b1 > 0 && m.purifyPreview, '提纯相关 API 可用')

// ───────── 3. 三档效果差距（草木<寒泉<龙涎）+ 各档到顶只数 ─────────
section('3. 三档效果差距')
const PURS = m.PURIFIERS
const pB = PURS.find(p => p.id === 'basic'), pF = PURS.find(p => p.id === 'fine'), pS = PURS.find(p => p.id === 'supreme')
ok(pB.power === 5 && pF.power === 12 && pS.power === 25, `power 草木${pB.power}/寒泉${pF.power}/龙涎${pS.power}`)
ok(pB.power < pF.power && pF.power < pS.power, '效果递增：草木 < 寒泉 < 龙涎')
ok(m.purifyStepOf('supreme') === 25 && m.purifyStepOf('basic') === 5, 'purifyStepOf 按剂型取步长')
// 真实 purifyPreview：同一块石头三档的 gainPct / leftToMax 应有明显差距
m.seedStones(WHO, 't4', 1)
const raw = m.stonesOf(WHO).find(s => s.status === 'uncut')
m.completeCut(WHO, raw.id)
const probe = m.stonesOf(WHO).find(s => s.id === raw.id)
const vB = m.purifyPreview(probe, 'basic', 0)
const vF = m.purifyPreview(probe, 'fine', 0)
const vS = m.purifyPreview(probe, 'supreme', 0)
ok(vB.gainPct < vF.gainPct && vF.gainPct < vS.gainPct, `同石涨幅递增：${vB.gainPct}% < ${vF.gainPct}% < ${vS.gainPct}%`)
ok(vS.leftToMax < vF.leftToMax && vF.leftToMax < vB.leftToMax, `到顶只数递减：龙涎${vS.leftToMax} < 寒泉${vF.leftToMax} < 草木${vB.leftToMax}`)
ok(vS.nextPurity > vF.nextPurity && vF.nextPurity > vB.nextPurity, `提纯后纯度递增：${(vB.nextPurity*100).toFixed(1)}% < ${(vF.nextPurity*100).toFixed(1)}% < ${(vS.nextPurity*100).toFixed(1)}%`)
ok(vS.nextValue > vB.nextValue, `龙涎提纯后估值高于草木（${vB.nextValue} < ${vS.nextValue}）`)

// ───────── 4. 真实提纯：用龙涎 4 只内到顶 ─────────
section('4. 龙涎 4 只内到顶（真实 purifyStone）')
{
  const t = m.purifiablesOf(WHO)[0]
  const goal = t.goalPurity ?? 1
  m.grantReagent(WHO, 'supreme', 20)
  let n = 0, cur = t
  while (n < 20) {
    const pv = m.purifyPreview(cur, 'supreme', m.reagentCountOf(WHO, 'supreme'))
    if (pv.maxed) break
    const rr = m.purifyStone(WHO, t.id, 'supreme')
    if (!rr.ok) { console.log(`     stop: ${rr.msg}`); break }
    n++; cur = m.stonesOf(WHO).find(s => s.id === t.id)
  }
  ok(n <= 4, `龙涎剂 ${n} 只到顶（≤4）`)
  ok((cur.purity ?? 0) >= goal - 1e-6, `纯度 ${((cur.purity ?? 0) * 100).toFixed(1)}% = 极限 ${(goal * 100).toFixed(1)}%`)
}

// ───────── 5. 无剂时拒绝 ─────────
section('5. 没提纯剂时拒绝提纯')
const t2 = m.purifiablesOf(WHO).find(s => !m.purifyPreview(s, 'fine', 0).maxed) ?? m.purifiablesOf(WHO)[0]
const rNo = m.purifyStone(WHO, t2.id, 'fine')
ok(!rNo.ok || m.reagentCountOf(WHO, 'fine') > 0, `无寒泉剂时被拒：${rNo.msg}`)

// ───────── 5. 打卡 ─────────
section('5. 每日打卡（固定奖励）')
const sBefore = m.stonesOf(WHO).length
const regBefore = m.reagentCountOf(WHO, 'supreme')
const ck = farm.doCheckin(WHO)
ok(ck.ok, `打卡成功：${ck.msg}`)
ok(m.stonesOf(WHO).length === sBefore + farm.CHECKIN_STONE_COUNT, `发 ${farm.CHECKIN_STONE_COUNT} 块帝王料（${sBefore}→${m.stonesOf(WHO).length}）`)
ok(m.reagentCountOf(WHO, 'supreme') === regBefore + farm.CHECKIN_REAGENT_COUNT, `发 ${farm.CHECKIN_REAGENT_COUNT} 只龙涎剂`)
const fuse = farm.CROPS.filter(c => c.fusionOnly)
ok(fuse.every(c => (wh()[farm.seedId(c.id)] ?? 0) >= 1), `每种特殊种子各 1 个（${fuse.length} 种）`)
const ck2 = farm.doCheckin(WHO)
ok(!ck2.ok, `同日重复打卡被拒：${ck2.msg}`)
ok(farm.hasCheckedIn(farmMap, WHO), 'hasCheckedIn=true')
ok(!farm.hasCheckedIn(farmMap, '成员A'), '未打卡者 hasCheckedIn=false')

console.log(`\n════ 结果：${pass} 通过 / ${fail} 失败 ════`)
process.exit(fail ? 1 : 0)
