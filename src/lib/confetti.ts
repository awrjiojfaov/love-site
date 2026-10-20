/**
 * 庆祝特效（tsParticles Confetti）：全站统一的"庆祝动作"。
 * - heartRain()  爱心雨：盲盒开箱、纪念日、爱情树升级等甜蜜瞬间
 * - firework()   烟花：从指定屏幕位置向四周炸开，适合转盘揭晓/开箱
 * 纯前端无状态、无 MQTT、不区分账号组，任何模块可随时调用。
 */
import { confetti } from 'tsparticles-confetti'

// 全站统一的情侣粉金配色
const PINKS = ['#e0487f', '#c44d7d', '#ff87b2', '#f78fb3', '#ffd6e7', '#f5a8c6']
// 烟花用暖金红，和夜色/转盘背景呼应
const FIRE = ['#ffd166', '#ff9f43', '#ef476f', '#ff6b9d', '#fff5c2']

/**
 * 爱心雨：在屏幕中间偏上撒下爱心 + 星星。
 * @param count 粒子上限，默认 60
 */
export function heartRain(count = 60): void {
  try {
    confetti('lovesite-hearts', {
      count,
      angle: 90,
      spread: 100,
      startVelocity: 40,
      decay: 0.94,
      gravity: 0.9,
      ticks: 220,
      position: { x: 50, y: 40 },
      colors: PINKS,
      shapes: ['heart', 'heart', 'star'],
      scalar: 1.15,
      zIndex: 9999,
      disableForReducedMotion: true,
    })
  } catch {
    /* 特效失败不阻断业务 */
  }
}

/**
 * 烟花：从屏幕某一点向四周炸开。
 * @param x 0~100（默认为屏幕中央 50）
 * @param y 0~100（默认为中央 50）
 */
export function firework(x = 50, y = 50): void {
  try {
    confetti('lovesite-firework', {
      count: 80,
      angle: 360,
      spread: 360,
      startVelocity: 32,
      decay: 0.92,
      gravity: 1,
      ticks: 200,
      position: { x, y },
      colors: FIRE,
      shapes: ['circle', 'star', 'heart'],
      scalar: 1.05,
      zIndex: 9999,
      disableForReducedMotion: true,
    })
  } catch {
    /* ignore */
  }
}

/**
 * 全字段综合庆祝：若干爱心雨 + 一轮烟花，用于重大里程碑（如爱情树满级）。
 */
export function bigCelebrate(): void {
  heartRain(70)
  setTimeout(() => firework(30, 40), 200)
  setTimeout(() => firework(70, 40), 450)
  setTimeout(() => firework(50, 30), 700)
}