// Баны (чат/сервер/глобально), кики, мут, тайм-аут, антифлуд.
import { redis } from "./kv.ts";
import { kickFromChat } from "./vk.ts";
import { getOwnerGroups } from "./setup.ts";

export type BanEventType = "ban" | "unban" | "sban" | "sunban" | "gban" | "gunban" | "kick" | "skick" | "gkick";

export interface BanRecord {
  reason: string;
  byUserId: number;
  at: number;
}

export interface BanHistoryEntry extends BanRecord {
  type: BanEventType;
  peerId?: number;
}

function historyKey(userId: number): string {
  return `b2:banhistory:${userId}`;
}

export async function logBanEvent(userId: number, entry: BanHistoryEntry): Promise<void> {
  await redis.rpush(historyKey(userId), JSON.stringify(entry));
}

export async function getBanHistory(userId: number): Promise<BanHistoryEntry[]> {
  const raw = await redis.lrange<string>(historyKey(userId), 0, -1);
  return (raw ?? []).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as BanHistoryEntry);
}

// --- Бан в одной беседе (/ban, /unban) ---

function chatBanKey(peerId: number, userId: number): string {
  return `b2:ban:${peerId}:${userId}`;
}

export async function setChatBan(peerId: number, userId: number, record: BanRecord): Promise<void> {
  await redis.set(chatBanKey(peerId, userId), record);
}

export async function clearChatBan(peerId: number, userId: number): Promise<void> {
  await redis.del(chatBanKey(peerId, userId));
}

export async function getChatBan(peerId: number, userId: number): Promise<BanRecord | null> {
  return (await redis.get<BanRecord>(chatBanKey(peerId, userId))) ?? null;
}

// --- Бан во всех беседах старшего администратора (/sban, /sunban) ---

function seniorBanKey(ownerId: number, userId: number): string {
  return `b2:sban:${ownerId}:${userId}`;
}

export async function setSeniorBan(ownerId: number, userId: number, record: BanRecord): Promise<void> {
  await redis.set(seniorBanKey(ownerId, userId), record);
  await redis.sadd(`b2:sban_owners:${userId}`, String(ownerId));
}

export async function clearSeniorBan(ownerId: number, userId: number): Promise<void> {
  await redis.del(seniorBanKey(ownerId, userId));
  await redis.srem(`b2:sban_owners:${userId}`, String(ownerId));
}

export async function getSeniorBan(ownerId: number, userId: number): Promise<BanRecord | null> {
  return (await redis.get<BanRecord>(seniorBanKey(ownerId, userId))) ?? null;
}

export async function getAllSeniorBans(userId: number): Promise<{ ownerId: number; record: BanRecord }[]> {
  const ownerIds = await redis.smembers(`b2:sban_owners:${userId}`);
  const result: { ownerId: number; record: BanRecord }[] = [];
  for (const ownerIdStr of ownerIds ?? []) {
    const record = await getSeniorBan(Number(ownerIdStr), userId);
    if (record) result.push({ ownerId: Number(ownerIdStr), record });
  }
  return result;
}

/** Забанен ли пользователь через /sban у старшего администратора, чья беседа — peerId. */
export async function isSeniorBannedInChat(
  peerId: number,
  userId: number,
): Promise<{ ownerId: number; record: BanRecord } | null> {
  const bans = await getAllSeniorBans(userId);
  for (const ban of bans) {
    const groups = await getOwnerGroups(ban.ownerId);
    if (groups.includes(peerId)) return ban;
  }
  return null;
}

// --- Глобальный бан (/gban, /gunban) ---

function globalBanKey(userId: number): string {
  return `b2:gban:${userId}`;
}

export async function setGlobalBan(userId: number, record: BanRecord): Promise<void> {
  await redis.set(globalBanKey(userId), record);
}

export async function clearGlobalBan(userId: number): Promise<void> {
  await redis.del(globalBanKey(userId));
}

export async function getGlobalBan(userId: number): Promise<BanRecord | null> {
  return (await redis.get<BanRecord>(globalBanKey(userId))) ?? null;
}

/** Есть ли у пользователя любая активная блокировка, действующая в этом чате. */
export async function getActiveBanForChat(peerId: number, userId: number): Promise<BanRecord | null> {
  const globalBan = await getGlobalBan(userId);
  if (globalBan) return globalBan;
  const chatBan = await getChatBan(peerId, userId);
  if (chatBan) return chatBan;
  const seniorBan = await isSeniorBannedInChat(peerId, userId);
  return seniorBan ? seniorBan.record : null;
}

// --- Массовые кики (/skick, /gkick) ---

export async function kickFromOwnerGroups(ownerId: number, userId: number): Promise<number> {
  const groups = await getOwnerGroups(ownerId);
  for (const peerId of groups) {
    await kickFromChat(peerId, userId).catch(() => {});
  }
  return groups.length;
}

export async function kickFromAllSyncedChats(userId: number): Promise<number> {
  const peerIds = await redis.smembers("b2:synced_chats");
  for (const peerIdStr of peerIds ?? []) {
    await kickFromChat(Number(peerIdStr), userId).catch(() => {});
  }
  return (peerIds ?? []).length;
}

// --- Мут (в рамках одной беседы) ---

function muteKey(peerId: number, userId: number): string {
  return `b2:mute:${peerId}:${userId}`;
}

export async function setMute(peerId: number, userId: number, minutes: number): Promise<void> {
  await redis.set(muteKey(peerId, userId), "1", { ex: Math.max(1, minutes) * 60 });
}

export async function clearMute(peerId: number, userId: number): Promise<void> {
  await redis.del(muteKey(peerId, userId));
}

export async function isMuted(peerId: number, userId: number): Promise<boolean> {
  return (await redis.exists(muteKey(peerId, userId))) === 1;
}

// --- Режим тишины на весь чат (/timeout) ---

function timeoutKey(peerId: number): string {
  return `b2:timeout:${peerId}`;
}

export async function setTimeoutMode(peerId: number, on: boolean): Promise<void> {
  if (on) await redis.set(timeoutKey(peerId), "1");
  else await redis.del(timeoutKey(peerId));
}

export async function isTimeoutActive(peerId: number): Promise<boolean> {
  return (await redis.exists(timeoutKey(peerId))) === 1;
}

// --- Антифлуд: более 5 одинаковых сообщений подряд — кик ---

interface FloodState {
  lastText: string;
  count: number;
}

function floodKey(peerId: number, userId: number): string {
  return `b2:flood:${peerId}:${userId}`;
}

/** Возвращает true, если пользователя пора кикнуть за флуд (сбрасывает счётчик). */
export async function trackFloodAndShouldKick(peerId: number, userId: number, text: string): Promise<boolean> {
  if (!text) return false;
  const raw = await redis.get<FloodState | string>(floodKey(peerId, userId));
  const state: FloodState = raw
    ? (typeof raw === "string" ? JSON.parse(raw) : raw)
    : { lastText: "", count: 0 };

  if (text === state.lastText) {
    state.count++;
  } else {
    state.lastText = text;
    state.count = 1;
  }

  if (state.count > 5) {
    await redis.del(floodKey(peerId, userId));
    return true;
  }

  await redis.set(floodKey(peerId, userId), state, { ex: 300 });
  return false;
}
