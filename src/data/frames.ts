/** 头像框图鉴：14 款，价格阶梯 200~1888（对齐心愿商店顶格手写信） */
import catear from '../assets/frames/catear.webp'
import candy from '../assets/frames/candy.webp'
import pumpkin from '../assets/frames/pumpkin.webp'
import sakura from '../assets/frames/sakura.webp'
import snow from '../assets/frames/snow.webp'
import forest from '../assets/frames/forest.webp'
import mermaid from '../assets/frames/mermaid.webp'
import starry from '../assets/frames/starry.webp'
import steampunk from '../assets/frames/steampunk.webp'
import cyberpunk from '../assets/frames/cyberpunk.webp'
import gothic from '../assets/frames/gothic.webp'
import jade from '../assets/frames/jade.webp'
import dunhuang from '../assets/frames/dunhuang.webp'
import crown from '../assets/frames/crown.webp'

export type FrameDef = { id: string; name: string; price: number; img: string }

export const FRAMES: FrameDef[] = [
  { id: 'catear', name: '萌系猫耳', price: 200, img: catear },
  { id: 'candy', name: '糖果甜心', price: 288, img: candy },
  { id: 'pumpkin', name: '万圣南瓜', price: 388, img: pumpkin },
  { id: 'sakura', name: '樱花少女', price: 488, img: sakura },
  { id: 'snow', name: '圣诞雪夜', price: 588, img: snow },
  { id: 'forest', name: '森林精灵', price: 688, img: forest },
  { id: 'mermaid', name: '深海人鱼', price: 788, img: mermaid },
  { id: 'starry', name: '梦幻星空', price: 888, img: starry },
  { id: 'steampunk', name: '蒸汽朋克', price: 988, img: steampunk },
  { id: 'cyberpunk', name: '赛博朋克', price: 1088, img: cyberpunk },
  { id: 'gothic', name: '暗黑哥特', price: 1188, img: gothic },
  { id: 'jade', name: '古风玉佩', price: 1288, img: jade },
  { id: 'dunhuang', name: '敦煌飞天', price: 1588, img: dunhuang },
  { id: 'crown', name: '华贵金冠', price: 1888, img: crown },
]

export function frameById(id: string | null | undefined): FrameDef | null {
  if (!id) return null
  return FRAMES.find((f) => f.id === id) ?? null
}
