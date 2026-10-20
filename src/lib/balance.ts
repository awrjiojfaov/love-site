/**
 * 时元余额的唯一口径（2026-10-17）。
 *
 * 旧实现每个页面自己算：`钱包账本 + 问答积分` 这一句被抄了 5 份，其中股票页漏抄了
 * 问答积分、存钱罐扣款校验干脆只看钱包 —— 于是同一个人在不同页面看到的时元不一样，
 * 「时元够不够」的结论也随页面而变。这就是「数量对不上」的一大来源。
 *
 * 今后所有「显示余额 / 判断够不够钱」一律走这里：
 * - React 页面（已经订阅了 txs / asks）：用 totalBalance(txs, asks, who)
 * - lib 层（没有订阅，如存钱罐扣款校验）：用 totalBalanceOf(who)，直接读两模块的快照
 */
import { walletBalance, walletSnapshot, type WalletTx } from './wallet'
import { balanceOf as quizBalanceOf, asksSnapshot, type AskItem } from './ask'

/** 时元总余额 = 钱包账本余额 + 问答积分 */
export function totalBalance(txs: WalletTx[], asks: AskItem[], who: string): number {
  return walletBalance(txs, who) + quizBalanceOf(asks, who)
}

/** 直接读两个模块当前快照的余额（lib 层用，无需订阅） */
export function totalBalanceOf(who: string): number {
  return totalBalance(walletSnapshot(), asksSnapshot(), who)
}
