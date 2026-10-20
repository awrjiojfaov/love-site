/**
 * 默认账号组成员的默认头像。
 *
 * 想换成自己的头像：直接替换 `src/assets/avatar-a.jpg` / `src/assets/avatar-b.jpg`，
 * 或在这里改成其它图片即可（昵称来自配置 VITE_MEMBER_A / VITE_MEMBER_B）。
 */
import avatarA from '../assets/avatar-a.jpg'
import avatarB from '../assets/avatar-b.jpg'
import { MEMBER_A, MEMBER_B } from '../config'

export { avatarA, avatarB }

/** 昵称 → 默认头像 */
export const MEMBER_AVATARS: Record<string, string> = {
  [MEMBER_A]: avatarA,
  [MEMBER_B]: avatarB,
}

/** 拿不到昵称时的兜底头像列表 */
export const MEMBER_AVATAR_LIST = [avatarA, avatarB]
