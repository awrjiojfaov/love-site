/**
 * 全站配置总入口 —— 所有「因部署而异」的值都从这里取。
 *
 * 取值规则：构建期环境变量（Vite 的 VITE_ 前缀）优先，未设时回退到下面的框架默认值。
 * - 真实部署值请写在仓库根目录的 `.env.local`（已被 .gitignore 忽略，绝不入库）；
 * - 可入库的样例见 `.env.example`。
 *
 * 本文件只保留「通用框架默认值」，不含任何真实个人数据、账号密码或服务器凭据。
 */

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

/** 读字符串型环境变量；空串或未设置时回退默认值 */
function str(key: string, fallback = ''): string {
  const v = env[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

/* ---------------- 站点信息 ---------------- */

/** 站点标题（浏览器标签 / PWA 名称） */
export const APP_TITLE = str('VITE_APP_TITLE', '秘密花园')
/** 站点描述 */
export const APP_DESC = str('VITE_APP_DESC', '两个人共享的小天地')
/** 登录页卡片标题 */
export const LOGIN_TITLE = str('VITE_LOGIN_TITLE', '我们的小窝')
/** ICP 备案号（留空则不显示；仅中国大陆自建站需要） */
export const ICP = str('VITE_ICP')

/* ---------------- 默认账号组的两个人 ---------------- */

/** 第一位成员昵称 */
export const MEMBER_A = str('VITE_MEMBER_A', '小雨')
/** 第二位成员昵称 */
export const MEMBER_B = str('VITE_MEMBER_B', '小晴')
/** 管理员昵称（可停用/解封花园、创建账号组）；默认取第二位成员 */
export const ADMIN_NAME = str('VITE_ADMIN_NAME', MEMBER_B)

export const MEMBER_A_PASSWORD = str('VITE_MEMBER_A_PASSWORD', '0000')
export const MEMBER_B_PASSWORD = str('VITE_MEMBER_B_PASSWORD', '0000')
/** 管理员密码；默认与第二位成员相同 */
export const ADMIN_PASSWORD = str('VITE_ADMIN_PASSWORD', MEMBER_B_PASSWORD)

/* ---------------- 数据同步（MQTT） ---------------- */

/**
 * 数据空间主题前缀。**每个部署务必设成自己独立的前缀**——
 * 公共 broker 是全网共享的，前缀相同 = 数据互相可见。
 */
export const TOPIC_PREFIX = str('VITE_TOPIC_PREFIX', 'lovesite/')

/** 自建 MQTT broker（可选）。不填则只使用代码内置的公共 broker 作为同步通道 */
export const MQTT_PRIMARY_URL = str('VITE_MQTT_PRIMARY_URL')
export const MQTT_PRIMARY_USER = str('VITE_MQTT_PRIMARY_USER')
export const MQTT_PRIMARY_PASS = str('VITE_MQTT_PRIMARY_PASS')

/* ---------------- 增量同步（syncDelta） ---------------- */

/**
 * 增量同步开关。开启后，体积较大的状态改为「只广播变化的那部分」，
 * 单次上传到对端可见从数百毫秒~1 秒降到毫秒级；全量仍会按自适应周期补发压实。
 * 设 `VITE_SYNC_DELTA=0` 可一键回退到改造前的逐字节行为（应急用）。
 */
export const SYNC_DELTA = str('VITE_SYNC_DELTA', '1') !== '0'

/* ---------------- 纪念日 ---------------- */

/**
 * 在一起的起始时刻（ISO 字符串，如 `2026-05-15T19:00:00`）。
 * 留空 = 主页不做写死的计时，由双方在页面上自行设置；纪念日盲盒同时停用。
 */
export const LOVE_START_ISO = str('VITE_LOVE_START')
export const LOVE_START: number = (() => {
  if (!LOVE_START_ISO) return 0
  const t = new Date(LOVE_START_ISO).getTime()
  return Number.isFinite(t) ? t : 0
})()

/* ---------------- 爱情树历史保底（一般留空） ---------------- */

/**
 * 默认空间贡献账本的永久下限（JSON 对象，如 `{"小雨":1000,"小晴":1200}`）。
 * 仅用于「历史数据被公共 broker 清空后」的找回，普通部署留空即可。
 */
export const TREE_FLOOR_JSON = str('VITE_TREE_FLOOR')
export const TREE_FLOOR: Record<string, number> = (() => {
  if (!TREE_FLOOR_JSON) return {}
  try {
    const o = JSON.parse(TREE_FLOOR_JSON) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
})()

/** 默认账号组的两位成员 */
export const DEFAULT_MEMBERS: [string, string] = [MEMBER_A, MEMBER_B]
