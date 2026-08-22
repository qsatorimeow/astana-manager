// Роли и права доступа. Хранилище — Upstash Redis (Sets).
import { redis } from "./kv.ts";

export type GlobalRole = "spec_admin" | "deputy_spec_admin";
export type ChatRole = "senior_admin" | "admin" | "senior_moderator" | "moderator";
export type AnyRole = "developer" | GlobalRole | ChatRole | "user";

export const ROLE_WEIGHT: Record<AnyRole, number> = {
  developer: 100,
  spec_admin: 90,
  deputy_spec_admin: 80,
  senior_admin: 70,
  admin: 60,
  senior_moderator: 50,
  moderator: 40,
  user: 0,
};

export const ROLE_LABEL: Record<AnyRole, string> = {
  developer: "Разработчик",
  spec_admin: "Спец. администратор",
  deputy_spec_admin: "Зам. спец. администратора",
  senior_admin: "Старший администратор",
  admin: "Администратор",
  senior_moderator: "Старший модератор",
  moderator: "Модератор",
  user: "Пользователь",
};

const CHAT_ROLES: ChatRole[] = ["senior_admin", "admin", "senior_moderator", "moderator"];

function developerIds(): number[] {
  return (Deno.env.get("DEVELOPER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

export function isDeveloperId(userId: number): boolean {
  return developerIds().includes(userId);
}

function globalRoleKey(role: GlobalRole): string {
  return `b2:role:global:${role}`;
}

export async function addGlobalRole(role: GlobalRole, userId: number): Promise<void> {
  await redis.sadd(globalRoleKey(role), String(userId));
}

export async function removeGlobalRole(role: GlobalRole, userId: number): Promise<void> {
  await redis.srem(globalRoleKey(role), String(userId));
}

export async function getGlobalRoleMembers(role: GlobalRole): Promise<number[]> {
  const members = await redis.smembers(globalRoleKey(role));
  return (members ?? []).map(Number);
}

export async function getUserGlobalRole(userId: number): Promise<GlobalRole | null> {
  const [isSpec, isDeputy] = await Promise.all([
    redis.sismember(globalRoleKey("spec_admin"), String(userId)),
    redis.sismember(globalRoleKey("deputy_spec_admin"), String(userId)),
  ]);
  if (isSpec) return "spec_admin";
  if (isDeputy) return "deputy_spec_admin";
  return null;
}

function chatRoleKey(peerId: number, role: ChatRole): string {
  return `b2:role:chat:${peerId}:${role}`;
}

export async function addChatRole(peerId: number, role: ChatRole, userId: number): Promise<void> {
  await redis.sadd(chatRoleKey(peerId, role), String(userId));
}

export async function removeChatRole(peerId: number, role: ChatRole, userId: number): Promise<void> {
  await redis.srem(chatRoleKey(peerId, role), String(userId));
}

export async function getChatRoleMembers(peerId: number, role: ChatRole): Promise<number[]> {
  const members = await redis.smembers(chatRoleKey(peerId, role));
  return (members ?? []).map(Number);
}

export async function getUserChatRole(peerId: number, userId: number): Promise<ChatRole | null> {
  for (const role of CHAT_ROLES) {
    if (await redis.sismember(chatRoleKey(peerId, role), String(userId))) return role;
  }
  return null;
}

export { CHAT_ROLES };

/** Итоговая роль и её "вес" — вес выше = прав больше. */
export async function resolveUserRole(peerId: number, userId: number): Promise<{ role: AnyRole; weight: number }> {
  if (isDeveloperId(userId)) return { role: "developer", weight: ROLE_WEIGHT.developer };

  const globalRole = await getUserGlobalRole(userId);
  if (globalRole) return { role: globalRole, weight: ROLE_WEIGHT[globalRole] };

  const chatRole = await getUserChatRole(peerId, userId);
  if (chatRole) return { role: chatRole, weight: ROLE_WEIGHT[chatRole] };

  return { role: "user", weight: ROLE_WEIGHT.user };
}

export async function hasAtLeastRole(peerId: number, userId: number, minRole: AnyRole): Promise<boolean> {
  const { weight } = await resolveUserRole(peerId, userId);
  return weight >= ROLE_WEIGHT[minRole];
}
