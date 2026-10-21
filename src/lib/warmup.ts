/**
 * 预热：登录进主页后在后台把剩余模块的云端订阅全部建立起来。
 * 之前这些模块要等点开对应功能页才初始化，冷启动要和海外 broker 握手 +
 * 等保留消息，手机上要卡好几秒。现在主页空闲时就提前连好、数据先到位，
 * 点开任何功能页都是内存里的最新数据，秒开。
 */
import { subscribeRatings as warmRatings } from './store'
import { subscribeQuiz } from './quiz'
import { subscribeMap } from './mapStore'
import { subscribeFrames } from './frames'
import { subscribeWishes } from './wish'
import { subscribeFishingLog } from './fishing'
import { subscribeMemoir } from './memoir'
import { subscribeFarm } from './farm'
import { subscribeWhisper } from './whisper'
import { subscribeDG } from './drawguess'
import { subscribeAuction } from './auction'
import { subscribeStocks } from './stockStore'

let warmed = false

export function warmupSync(): void {
  if (warmed) return
  warmed = true
  const noop = () => {
    /* 只为触发模块初始化与云端订阅，数据由模块自己维护 */
  }
  try {
    warmRatings(noop)
    subscribeQuiz(noop)
    subscribeMap(noop)
    subscribeFrames(noop)
    subscribeWishes(noop) // 预热许愿池/心愿商店：进主页即连好，点开货架秒开
    subscribeFishingLog(noop)
    subscribeMemoir(noop)
    subscribeFarm(noop) // 预热农场：确保仓库物品相关的收发在农场云端就绪后再执行，避免「偶尔东西没到账」
    subscribeWhisper(noop) // 悄悄话：进主页即连好，打开聊天秒开
    subscribeDG(noop, noop) // 你画我猜：预热双主题订阅
    subscribeAuction(noop) // 玉缘拍卖会：预热云端订阅，点开即最新
    subscribeStocks(noop) // 时元股交所：预热云端订阅，点开即可交易
  } catch {
    warmed = false // 出错了下次再试
  }
}
