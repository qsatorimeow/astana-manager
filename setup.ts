// Настройка чата: синхронизация (получение/обновление данных чата) + привязка к серверу.
// Бот не выполняет обычные команды, пока оба шага не пройдены.
import { redis } from "./kv.ts";
import { callVkApi, getConversationMembers, nameLinkOfAny } from "./vk.ts";
import { getChatServer } from "./servers.ts";

export interface SyncRecord {
  chatName: string;
  ownerId: number; // может быть отрицательным (сообщество)
  syncedBy: number;
  syncedAt: number;
}

function syncKey(peerId: number): string {
  return `b2:sync:${peerId}`;
}

/** Забирает актуальное название беседы и её владельца из VK и сохраняет/обновляет запись. */
export async function syncChat(peerId: number, byUserId: number): Promise<{ record: SyncRecord; wasNew: boolean }> {
  const wasNew = !(await isSynced(peerId));

  const [titleData, members] = await Promise.all([
    callVkApi("messages.getConversationsById", { peer_ids: String(peerId) }),
    getConversationMembers(peerId),
  ]);

  const chatName = titleData?.response?.items?.[0]?.chat_settings?.title ?? `Беседа ${peerId}`;
  const owner = members.find((m) => m.isOwner);
  const ownerId = owner?.memberId ?? 0;

  const record: SyncRecord = { chatName, ownerId, syncedBy: byUserId, syncedAt: Date.now() };
  await redis.set(syncKey(peerId), record);
  await redis.sadd("b2:synced_chats", String(peerId));
  return { record, wasNew };
}

export async function clearSync(peerId: number): Promise<void> {
  await redis.del(syncKey(peerId));
  await redis.srem("b2:synced_chats", String(peerId));
}

export async function isSynced(peerId: number): Promise<boolean> {
  return (await redis.exists(syncKey(peerId))) === 1;
}

export async function getSyncRecord(peerId: number): Promise<SyncRecord | null> {
  return (await redis.get<SyncRecord>(syncKey(peerId))) ?? null;
}

export async function getSyncedChats(): Promise<number[]> {
  const members = await redis.smembers("b2:synced_chats");
  return (members ?? []).map(Number);
}

export async function buildSyncListMessage(): Promise<string> {
  const peerIds = await getSyncedChats();
  if (peerIds.length === 0) return "Список синхронизированных чатов пуст.";

  const lines = ["Список синхронизированных чатов:", ""];
  for (const peerId of peerIds) {
    const record = await getSyncRecord(peerId);
    if (!record) continue;
    const ownerLink = record.ownerId ? await nameLinkOfAny(record.ownerId) : "неизвестно";
    lines.push(`"${record.chatName}" | ${ownerLink} | ${peerId}`);
  }
  return lines.join("\n");
}

// --- Проверка готовности чата к использованию бота: /sync + /server ---

export async function isChatConfigured(peerId: number): Promise<boolean> {
  const [synced, server] = await Promise.all([isSynced(peerId), getChatServer(peerId)]);
  return synced && server !== null;
}

export async function getConfigStatusMessage(peerId: number): Promise<string> {
  const [synced, server] = await Promise.all([isSynced(peerId), getChatServer(peerId)]);
  const lines = ["Чат ещё не готов к использованию бота. Осталось:"];
  if (!synced) lines.push("— /sync (синхронизация с базой данных)");
  if (!server) lines.push("— /server название (привязать беседу к серверу проекта)");
  return lines.join("\n");
}
