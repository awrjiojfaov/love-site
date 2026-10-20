import type { User } from './LoginPage'
import { RatingBoard } from './RatingsPage'
import * as dostore from '../lib/dostore'

/** do打分（秘密空间·隐藏打分系统）：布局与见闻打分一致，数据完全独立 */
export default function DoRatingsPage({ user, onBack }: { user: User; onBack: () => void }) {
  return (
    <RatingBoard
      user={user}
      onBack={onBack}
      store={dostore}
      pageTitle="do打分"
      rewards={{ create: 30 }}
    />
  )
}
