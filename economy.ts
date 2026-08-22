// Экономика: баланс (глобальный), 1 сообщение = 1 монета, /reward раз в 3 часа.
import { redis } from "./kv.ts";
import { getConversationMembers, getUsersInfo, mention } from "./vk.ts";

const REWARD_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 часа
const REWARD_MIN = 80;
const REWARD_MAX = 120;

function balanceSetKey(): string {
  return "b2:balance"; // ZSET: member=userId, score=баланс (глобальный)
}

function rewardCooldownKey(userId: number): string {
  return `b2:reward_cd:${userId}`;
}

function messageCountKey(peerId: number, userId: number): string {
  return `b2:msgcount:${peerId}:${userId}`;
}

function lastMessageKey(peerId: number, userId: number): string {
  return `b2:lastmsg:${peerId}:${userId}`;
}

export async function getBalance(userId: number): Promise<number> {
  const score = await redis.zscore(balanceSetKey(), String(userId));
  return Number(score ?? 0);
}

export async function addBalance(userId: number, amount: number): Promise<number> {
  const newScore = await redis.zincrby(balanceSetKey(), amount, String(userId));
  return Number(newScore);
}

/** Списывает монеты, если хватает баланса. Возвращает true при успехе. */
export async function transferBalance(fromUserId: number, toUserId: number, amount: number): Promise<boolean> {
  const balance = await getBalance(fromUserId);
  if (balance < amount) return false;
  await addBalance(fromUserId, -amount);
  await addBalance(toUserId, amount);
  return true;
}

export async function tryClaimReward(userId: number): Promise<{ ok: true; amount: number } | { ok: false; msLeft: number }> {
  const lastClaim = await redis.get<string | number>(rewardCooldownKey(userId));
  const lastClaimMs = lastClaim ? Number(lastClaim) : 0;
  const elapsed = Date.now() - lastClaimMs;

  if (elapsed < REWARD_COOLDOWN_MS) {
    return { ok: false, msLeft: REWARD_COOLDOWN_MS - elapsed };
  }

  const amount = Math.floor(Math.random() * (REWARD_MAX - REWARD_MIN + 1)) + REWARD_MIN;
  await addBalance(userId, amount);
  await redis.set(rewardCooldownKey(userId), String(Date.now()));
  return { ok: true, amount };
}

/** Учитывает сообщение пользователя в чате: +1 монета, +1 к счётчику, обновляет время последнего. */
export async function trackMessage(peerId: number, userId: number): Promise<void> {
  await Promise.all([
    redis.incr(messageCountKey(peerId, userId)),
    redis.set(lastMessageKey(peerId, userId), String(Date.now())),
    addBalance(userId, 1),
  ]);
}

export async function getMessageStats(
  peerId: number,
  userId: number,
): Promise<{ count: number; lastMessageMs: number | null }> {
  const [count, last] = await Promise.all([
    redis.get<string | number>(messageCountKey(peerId, userId)),
    redis.get<string | number>(lastMessageKey(peerId, userId)),
  ]);
  return {
    count: count ? Number(count) : 0,
    lastMessageMs: last ? Number(last) : null,
  };
}

/** Топ-10 по балансу среди участников конкретного чата. */
export async function getChatTop(peerId: number, limit = 10): Promise<{ userId: number; balance: number }[]> {
  const members = await getConversationMembers(peerId);
  const results: { userId: number; balance: number }[] = [];
  for (const member of members) {
    if (member.memberId <= 0) continue; // пропускаем сообщества
    const balance = await getBalance(member.memberId);
    if (balance > 0) results.push({ userId: member.memberId, balance });
  }
  return results.sort((a, b) => b.balance - a.balance).slice(0, limit);
}

/** Топ-10 по балансу среди вообще всех известных пользователей. */
export async function getGlobalTop(limit = 10): Promise<{ userId: number; balance: number }[]> {
  const members = await redis.zrange<string[]>(balanceSetKey(), 0, limit - 1, { rev: true });
  const results: { userId: number; balance: number }[] = [];
  for (const member of members ?? []) {
    const balance = await getBalance(Number(member));
    results.push({ userId: Number(member), balance });
  }
  return results;
}

export async function formatTopList(entries: { userId: number; balance: number }[]): Promise<string> {
  if (entries.length === 0) return "Пока никто не заработал монет.";
  const infoMap = await getUsersInfo(entries.map((e) => e.userId));
  const medals = ["🥇", "🥈", "🥉"];
  return entries
    .map((e, i) => `${medals[i] ?? "🎖"} ${mention(e.userId, infoMap.get(e.userId))} — ${e.balance} монет`)
    .join("\n");
}
