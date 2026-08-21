// Слой хранения для системы мероприятий. Upstash Redis автоматически
// сериализует/десериализует объекты в JSON, поэтому передаём их как есть.
import { redis } from "../kv.ts";

export type EntryStatus = "waiting" | "active" | "finished" | "cancelled" | "timeout";

export interface EventEntry {
  id: number;
  peerId: number;
  eventName: string;
  ownerId: number;
  ownerName: string; // готовое отображаемое имя (упоминание или ник)
  status: EntryStatus;
  createdAt: number;
  activatedAt?: number;
  kdAt?: number; // для finished: время окончания КД
  scheduledAt?: number; // для waiting: когда именно этот игрок должен стать active
  cancelReasonRequestedBy?: number; // модератор, запросивший причину аннулирования
  cancelReasonDeadline?: number; // дедлайн ввода причины (60 секунд)
  readyNotifiedAt?: number; // когда игроку отправили уведомление «Готовьтесь»
  kdDisplay?: string; // как показывать КД в сообщении
  lastReminderAt?: number;
  messageId?: number; // глобальный id сообщения "занял мероприятие"
  conversationMessageId?: number; // id сообщения в рамках беседы — предпочтителен для messages.edit
}

function entryKey(peerId: number, id: number): string {
  return `event:entry:${peerId}:${id}`;
}

function queueKey(peerId: number): string {
  return `event:queue:${peerId}`;
}

function seqKey(peerId: number): string {
  return `event:seq:${peerId}`;
}

function pendingIndexKey(peerId: number): string {
  return `event:pending:${peerId}`;
}

function chatsWithPendingKey(): string {
  return "event:pending:chats";
}

export async function nextEntryId(peerId: number): Promise<number> {
  return await redis.incr(seqKey(peerId));
}

export async function saveEntry(entry: EventEntry): Promise<void> {
  await redis.set(entryKey(entry.peerId, entry.id), entry);
  if (entry.status === "waiting" || entry.status === "active") {
    await redis.sadd(pendingIndexKey(entry.peerId), String(entry.id));
    await redis.sadd(chatsWithPendingKey(), String(entry.peerId));
  } else {
    await redis.srem(pendingIndexKey(entry.peerId), String(entry.id));
    const remaining = await redis.scard(pendingIndexKey(entry.peerId));
    if (remaining === 0) await redis.srem(chatsWithPendingKey(), String(entry.peerId));
  }
}

export async function getEntry(peerId: number, id: number): Promise<EventEntry | null> {
  const entry = await redis.get<EventEntry>(entryKey(peerId, id));
  return entry ?? null;
}

export async function pushToQueue(peerId: number, _eventName: string, id: number): Promise<void> {
  await redis.rpush(queueKey(peerId), String(id));
}

export async function peekQueueHead(peerId: number, _eventName?: string): Promise<number | null> {
  const items = await redis.lrange<string>(queueKey(peerId), 0, 0);
  return items.length > 0 ? Number(items[0]) : null;
}

export async function popQueueHead(peerId: number, _eventName?: string): Promise<number | null> {
  const id = await redis.lpop<string>(queueKey(peerId));
  return id !== null && id !== undefined ? Number(id) : null;
}

export async function removeFromQueue(peerId: number, _eventName: string, id: number): Promise<void> {
  await redis.lrem(queueKey(peerId), 0, String(id));
}

/** Восстанавливает одну общую очередь по времени создания. Нужна также для миграции старых данных. */
export async function rebuildQueue(peerId: number): Promise<void> {
  const ids = await getPendingEntryIds(peerId);
  const entries: EventEntry[] = [];
  for (const id of ids) {
    const entry = await getEntry(peerId, id);
    if (entry && (entry.status === "waiting" || entry.status === "active")) entries.push(entry);
  }
  entries.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  await redis.del(queueKey(peerId));
  if (entries.length > 0) {
    await redis.rpush(queueKey(peerId), ...entries.map((e) => String(e.id)));
  }
}

/** Все чаты, где сейчас есть незавершённые записи (для планового опроса cron-ом). */
export async function getChatsWithPending(): Promise<number[]> {
  const members = await redis.smembers(chatsWithPendingKey());
  return (members ?? []).map(Number);
}

export async function getPendingEntryIds(peerId: number): Promise<number[]> {
  const members = await redis.smembers(pendingIndexKey(peerId));
  return (members ?? []).map(Number);
}

// --- Ожидание ввода произвольного КД текстом (после кнопки "Написать КД") ---

function awaitingKdKey(peerId: number, userId: number): string {
  return `event:awaitingkd:${peerId}:${userId}`;
}

export async function setAwaitingKd(peerId: number, userId: number, entryId: number): Promise<void> {
  await redis.set(awaitingKdKey(peerId, userId), String(entryId), { ex: 900 });
}

export async function getAwaitingKd(peerId: number, userId: number): Promise<number | null> {
  const val = await redis.get<string | number>(awaitingKdKey(peerId, userId));
  return val !== null && val !== undefined ? Number(val) : null;
}

export async function clearAwaitingKd(peerId: number, userId: number): Promise<void> {
  await redis.del(awaitingKdKey(peerId, userId));
}

// --- Ожидание причины аннулирования (после кнопки "Аннулировать", модератор) ---

function awaitingReasonKey(peerId: number, userId: number): string {
  return `event:awaitingreason:${peerId}:${userId}`;
}

export async function setAwaitingReason(peerId: number, userId: number, entryId: number): Promise<void> {
  await redis.set(awaitingReasonKey(peerId, userId), String(entryId), { ex: 60 });
}

export async function getAwaitingReason(peerId: number, userId: number): Promise<number | null> {
  const val = await redis.get<string | number>(awaitingReasonKey(peerId, userId));
  return val !== null && val !== undefined ? Number(val) : null;
}

export async function clearAwaitingReason(peerId: number, userId: number): Promise<void> {
  await redis.del(awaitingReasonKey(peerId, userId));
}

// --- Модераторы (в рамках конкретной беседы) ---

function moderatorsKey(peerId: number): string {
  return `event:moderators:${peerId}`;
}

export async function addModerator(peerId: number, userId: number): Promise<void> {
  await redis.sadd(moderatorsKey(peerId), String(userId));
}

export async function removeModerator(peerId: number, userId: number): Promise<void> {
  await redis.srem(moderatorsKey(peerId), String(userId));
}

export async function isModerator(peerId: number, userId: number): Promise<boolean> {
  const result = await redis.sismember(moderatorsKey(peerId), String(userId));
  return !!result;
}

// --- Ники (в рамках конкретной беседы) ---

function nickKey(peerId: number, userId: number): string {
  return `event:nick:${peerId}:${userId}`;
}

export async function setNick(peerId: number, userId: number, nick: string): Promise<void> {
  await redis.set(nickKey(peerId, userId), nick);
}

export async function getNick(peerId: number, userId: number): Promise<string | null> {
  const val = await redis.get<string>(nickKey(peerId, userId));
  return val ?? null;
}

// --- Топ по количеству успешно завершённых мероприятий ---

function leaderboardKey(peerId: number): string {
  return `event:leaderboard:${peerId}`;
}

function totalKey(peerId: number): string {
  return `event:total:${peerId}`;
}

export async function incrementStats(peerId: number, userId: number): Promise<void> {
  await redis.zincrby(leaderboardKey(peerId), 1, String(userId));
  await redis.incr(totalKey(peerId));
}

export async function getTopUsers(peerId: number, limit = 10): Promise<{ userId: number; count: number }[]> {
  const members = await redis.zrange<string[]>(leaderboardKey(peerId), 0, limit - 1, { rev: true });
  const result: { userId: number; count: number }[] = [];
  for (const member of members ?? []) {
    const score = await redis.zscore(leaderboardKey(peerId), member);
    result.push({ userId: Number(member), count: Number(score ?? 0) });
  }
  return result;
}

export async function getTotalCount(peerId: number): Promise<number> {
  const val = await redis.get<string | number>(totalKey(peerId));
  return val ? Number(val) : 0;
}

// --- Отложенное удаление служебных сообщений бота (через 60 секунд) ---

function pendingDeleteKey(): string {
  return "event:pending_deletes";
}

export async function scheduleDelete(peerId: number, messageId: number, delayMs = 60_000): Promise<void> {
  await redis.zadd(pendingDeleteKey(), { score: Date.now() + delayMs, member: `${peerId}:${messageId}` });
}

export async function getDueDeletes(limit = 100): Promise<{ peerId: number; messageId: number }[]> {
  const raw = await redis.zrange<string[]>(pendingDeleteKey(), 0, Date.now(), { byScore: true });
  return (raw ?? []).slice(0, limit).map((item) => {
    const [peerId, messageId] = item.split(":");
    return { peerId: Number(peerId), messageId: Number(messageId) };
  });
}

export async function clearPendingDelete(peerId: number, messageId: number): Promise<void> {
  await redis.zrem(pendingDeleteKey(), `${peerId}:${messageId}`);
}