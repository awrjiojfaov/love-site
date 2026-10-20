/**
 * 中国地图 GeoJSON 加载与投影（阿里云 DataV.GeoAtlas，运行时拉取 + localStorage 缓存）。
 * 全国省级：100000_full.json；某省市级：{adcode}_full.json。
 * 投影为简单等距圆柱（经度→x，纬度→y 翻转），双参数同比例缩放，手机端观感足够好。
 */

export type GeoFeature = {
  /** 数字 adcode；全国图里「十段线」是字符串 '100000_JD'，不可点击 */
  adcode: number | string
  name: string
  /** SVG path（已投影到 viewBox 坐标系） */
  path: string
  /** 标签锚点（投影后坐标） */
  label: [number, number]
}

export type GeoMap = {
  features: GeoFeature[]
  viewBox: string
  width: number
  height: number
  /** 十段线插图框（仅全国图有）：虚线小框画在这个位置 */
  inset?: { x: number; y: number; w: number; h: number }
}

type RawFeature = {
  properties: {
    adcode: number
    name: string
    center?: [number, number]
    centroid?: [number, number]
  }
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
    | null
}

const CACHE_PREFIX = 'lovesite-geo-v2-'

/** 原始 GeoJSON（阿里云 DataV 回退源） */
async function fetchRaw(adcode: number): Promise<RawFeature[]> {
  const res = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`)
  if (!res.ok) throw new Error(`地图数据加载失败（${res.status}）`)
  const json = (await res.json()) as { features: RawFeature[] }
  return json.features.filter((f) => f.geometry)
}

/**
 * 加载投影后的地图：优先同源 /geo/{adcode}.json（部署时预生成，秒开），
 * 失败再回退阿里云 DataV 原始数据本地投影；两层都走 localStorage 缓存。
 */
async function fetchGeo(adcode: number): Promise<GeoMap> {
  const cacheKey = `${CACHE_PREFIX}${adcode}`
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) return JSON.parse(cached) as GeoMap
  } catch {
    /* ignore */
  }
  let map: GeoMap | null = null
  try {
    const res = await fetch(`/geo/${adcode}.json`)
    if (res.ok) map = (await res.json()) as GeoMap
  } catch {
    /* 走回退 */
  }
  if (!map || !Array.isArray(map.features)) map = buildMap(await fetchRaw(adcode))
  try {
    localStorage.setItem(cacheKey, JSON.stringify(map))
  } catch {
    /* 缓存满就算了 */
  }
  return map
}

/** 生成 SVG path：坐标保留 1 位小数控制体积 */
function buildMap(raw: RawFeature[]): GeoMap {
  // 全图经纬度包围盒
  let minLon = 180
  let maxLon = -180
  let minLat = 90
  let maxLat = -90
  const scan = (lon: number, lat: number) => {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  for (const f of raw) {
    if (!f.geometry) continue
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) scan(lon, lat)
      }
    }
  }

  const W = 1000
  const lonSpan = maxLon - minLon || 1
  const latSpan = maxLat - minLat || 1
  const s = W / lonSpan
  const H = Math.round(latSpan * s)

  const px = (lon: number) => Math.round((lon - minLon) * s * 10) / 10
  const py = (lat: number) => Math.round((maxLat - lat) * s * 10) / 10

  const features: GeoFeature[] = raw
    .filter((f) => f.geometry)
    .map((f) => {
      const polys = f.geometry!.type === 'Polygon' ? [f.geometry!.coordinates as number[][][]] : (f.geometry!.coordinates as number[][][][])
      const parts: string[] = []
      for (const poly of polys) {
        for (const ring of poly) {
          const d = ring.map(([lon, lat], i) => `${i === 0 ? 'M' : 'L'}${px(lon)},${py(lat)}`).join('')
          parts.push(`${d}Z`)
        }
      }
      const c = f.properties.centroid ?? f.properties.center ?? [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
      return {
        adcode: f.properties.adcode,
        name: f.properties.name,
        path: parts.join(''),
        label: [px(c[0]), py(c[1])] as [number, number],
      }
    })

  return { features, viewBox: `0 0 ${W} ${H}`, width: W, height: H }
}

/** 全国省级地图 */
export async function loadChinaMap(): Promise<GeoMap> {
  return fetchGeo(100000)
}

/** 某省市级地图（直辖市的"市"即区县） */
export async function loadProvinceMap(provAdcode: number): Promise<GeoMap> {
  return fetchGeo(provAdcode)
}

/** 由市/区 adcode 推省 adcode（中国行政区划：前两位为省） */
export function provinceOf(adcode: number): number {
  return Math.floor(adcode / 10000) * 10000
}
