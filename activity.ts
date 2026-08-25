// Статистика активности (для /stats). Монеты/баланс удалены — больше не используются.
import { redis } from "./kv.ts";

function messageCountKey(peerId: number, userId: number): string {
  return `b2:msgcount:${peerId}:${userId}`;
}

function lastMessageKey(peerId: number, userId: number): string {
  return `b2:lastmsg:${peerId}:${userId}`;
}

export async function trackMessage(peerId: number, userId: number): Promise<void> {
  await Promise.all([
    redis.incr(messageCountKey(peerId, userId)),
    redis.set(lastMessageKey(peerId, userId), String(Date.now())),
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

export async function clearActivity(peerId: number, userId: number): Promise<void> {
  await redis.del(messageCountKey(peerId, userId));
  await redis.del(lastMessageKey(peerId, userId));
}
