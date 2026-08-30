// Ники, назначаемые модератором другим участникам чата.
import { redis } from "./kv.ts";

function nickKey(peerId: number, userId: number): string {
  return `b2:nick:${peerId}:${userId}`;
}

function nickOwnerKey(peerId: number, nick: string): string {
  return `b2:nick_owner:${peerId}:${nick.toLowerCase()}`;
}

function nickIndexKey(peerId: number): string {
  return `b2:nick_index:${peerId}`;
}

export async function setNickFor(peerId: number, userId: number, nick: string): Promise<void> {
  await removeNickFor(peerId, userId); // на случай смены ника — убираем старую запись поиска
  await redis.set(nickKey(peerId, userId), nick);
  await redis.set(nickOwnerKey(peerId, nick), String(userId));
  await redis.sadd(nickIndexKey(peerId), String(userId));
}

export async function removeNickFor(peerId: number, userId: number): Promise<void> {
  const nick = await getNickFor(peerId, userId);
  await redis.del(nickKey(peerId, userId));
  if (nick) await redis.del(nickOwnerKey(peerId, nick));
  await redis.srem(nickIndexKey(peerId), String(userId));
}

export async function getNickFor(peerId: number, userId: number): Promise<string | null> {
  return (await redis.get<string>(nickKey(peerId, userId))) ?? null;
}

export async function findUserIdByNick(peerId: number, nick: string): Promise<number | null> {
  const val = await redis.get<string | number>(nickOwnerKey(peerId, nick));
  return val !== null && val !== undefined ? Number(val) : null;
}

export async function listNicks(peerId: number): Promise<{ userId: number; nick: string }[]> {
  const ids = await redis.smembers(nickIndexKey(peerId));
  const result: { userId: number; nick: string }[] = [];
  for (const idStr of ids ?? []) {
    const nick = await getNickFor(peerId, Number(idStr));
    if (nick) result.push({ userId: Number(idStr), nick });
  }
  return result;
}
