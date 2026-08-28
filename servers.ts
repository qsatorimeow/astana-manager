// "Сервер" — именованная группа бесед проекта. Создаётся зам. спец. администратором,
// затем конкретная беседа привязывается к серверу командой /server название.
import { redis } from "./kv.ts";

function serversKey(): string {
  return "b2:servers";
}

function serverOriginalNameKey(nameLower: string): string {
  return `b2:server_name:${nameLower}`;
}

function serverChatsKey(nameLower: string): string {
  return `b2:server_chats:${nameLower}`;
}

function chatServerKey(peerId: number): string {
  return `b2:chat_server:${peerId}`;
}

export async function addServer(name: string): Promise<boolean> {
  const nameLower = name.toLowerCase();
  const exists = await redis.sismember(serversKey(), nameLower);
  if (exists) return false;
  await redis.sadd(serversKey(), nameLower);
  await redis.set(serverOriginalNameKey(nameLower), name);
  return true;
}

export async function removeServer(name: string): Promise<void> {
  const nameLower = name.toLowerCase();
  await redis.srem(serversKey(), nameLower);
  await redis.del(serverOriginalNameKey(nameLower));
}

export async function serverExists(name: string): Promise<boolean> {
  return !!(await redis.sismember(serversKey(), name.toLowerCase()));
}

export async function listServers(): Promise<string[]> {
  const namesLower = await redis.smembers(serversKey());
  const result: string[] = [];
  for (const n of namesLower ?? []) {
    const original = await redis.get<string>(serverOriginalNameKey(n));
    result.push(original ?? n);
  }
  return result;
}

export async function bindChatToServer(peerId: number, name: string): Promise<void> {
  const prevServer = await getChatServer(peerId);
  if (prevServer) await redis.srem(serverChatsKey(prevServer.toLowerCase()), String(peerId));
  await redis.set(chatServerKey(peerId), name);
  await redis.sadd(serverChatsKey(name.toLowerCase()), String(peerId));
}

export async function getChatServer(peerId: number): Promise<string | null> {
  return (await redis.get<string>(chatServerKey(peerId))) ?? null;
}

export async function getServerChats(name: string): Promise<number[]> {
  const members = await redis.smembers(serverChatsKey(name.toLowerCase()));
  return (members ?? []).map(Number);
}
