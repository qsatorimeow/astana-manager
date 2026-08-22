// Настройка чата: синхронизация, привязка к серверу старшего администратора, тип беседы.
// Бот не выполняет обычные команды, пока все три шага не пройдены.
import { redis } from "./kv.ts";
import { nameLinkOf } from "./vk.ts";

export type ChatType = "admin" | "player";

export const CHAT_TYPE_LABEL: Record<ChatType, string> = {
  admin: "Административный чат",
  player: "Беседа игроков",
};

// --- Синхронизация (доступно спец. и зам. спец. администратору) ---

function syncKey(peerId: number): string {
  return `b2:sync:${peerId}`;
}

export async function setSync(peerId: number, ownerUserId: number): Promise<void> {
  await redis.set(syncKey(peerId), String(ownerUserId));
  await redis.sadd("b2:synced_chats", String(peerId));
}

export async function clearSync(peerId: number): Promise<void> {
  await redis.del(syncKey(peerId));
  await redis.srem("b2:synced_chats", String(peerId));
}

export async function isSynced(peerId: number): Promise<boolean> {
  return (await redis.exists(syncKey(peerId))) === 1;
}

export async function getSyncOwner(peerId: number): Promise<number | null> {
  const val = await redis.get<string | number>(syncKey(peerId));
  return val !== null && val !== undefined ? Number(val) : null;
}

export async function getSyncedChats(): Promise<number[]> {
  const members = await redis.smembers("b2:synced_chats");
  return (members ?? []).map(Number);
}

export async function buildSyncListMessage(): Promise<string> {
  const peerIds = await getSyncedChats();
  if (peerIds.length === 0) return "Список синхронизированных чатов пуст.";

  const lines = ["Список синхронизированных чатов:"];
  for (const peerId of peerIds) {
    const ownerId = await getSyncOwner(peerId);
    const ownerName = ownerId ? await nameLinkOf(ownerId) : "неизвестно";
    lines.push(`Чат ${peerId} | ${ownerName}`);
  }
  return lines.join("\n");
}

// --- Привязка чата к своему списку (доступно старшему администратору) ---

function groupOwnerKey(peerId: number): string {
  return `b2:group_owner:${peerId}`;
}

function ownerGroupsKey(ownerUserId: number): string {
  return `b2:owner_groups:${ownerUserId}`;
}

export async function addGroup(peerId: number, ownerUserId: number): Promise<void> {
  await redis.set(groupOwnerKey(peerId), String(ownerUserId));
  await redis.sadd(ownerGroupsKey(ownerUserId), String(peerId));
}

export async function removeGroup(peerId: number, ownerUserId: number): Promise<void> {
  await redis.del(groupOwnerKey(peerId));
  await redis.srem(ownerGroupsKey(ownerUserId), String(peerId));
}

export async function isGroupAdded(peerId: number): Promise<boolean> {
  return (await redis.exists(groupOwnerKey(peerId))) === 1;
}

export async function getGroupOwner(peerId: number): Promise<number | null> {
  const val = await redis.get<string | number>(groupOwnerKey(peerId));
  return val !== null && val !== undefined ? Number(val) : null;
}

export async function getOwnerGroups(ownerUserId: number): Promise<number[]> {
  const members = await redis.smembers(ownerGroupsKey(ownerUserId));
  return (members ?? []).map(Number);
}

// --- Тип беседы (доступно старшему администратору) ---

function chatTypeKey(peerId: number): string {
  return `b2:chattype:${peerId}`;
}

export async function setChatType(peerId: number, type: ChatType): Promise<void> {
  await redis.set(chatTypeKey(peerId), type);
}

export async function getChatType(peerId: number): Promise<ChatType | null> {
  const val = await redis.get<ChatType>(chatTypeKey(peerId));
  return val ?? null;
}

// --- Общая проверка готовности чата к использованию бота ---

export async function isChatConfigured(peerId: number): Promise<boolean> {
  const [synced, grouped, type] = await Promise.all([
    isSynced(peerId),
    isGroupAdded(peerId),
    getChatType(peerId),
  ]);
  return synced && grouped && type !== null;
}

export async function getConfigStatusMessage(peerId: number): Promise<string> {
  const [synced, grouped, type] = await Promise.all([
    isSynced(peerId),
    isGroupAdded(peerId),
    getChatType(peerId),
  ]);
  const lines = ["⚙️ Чат ещё не готов к использованию бота. Осталось:"];
  if (!synced) lines.push("— /sync (синхронизация с базой данных)");
  if (!grouped) lines.push("— /addgroup (привязать чат к своему списку)");
  if (!type) lines.push("— /type (выбрать тип беседы)");
  return lines.join("\n");
}
