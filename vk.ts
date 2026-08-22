// Вспомогательные функции для работы с VK API.

const VK_TOKEN = Deno.env.get("VK_TOKEN") ?? "";
const VK_API_VERSION = "5.199";

// deno-lint-ignore no-explicit-any
export async function callVkApi(method: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({
    ...params,
    access_token: VK_TOKEN,
    v: VK_API_VERSION,
  });
  const res = await fetch(`https://api.vk.com/method/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (data.error) {
    console.error(`[VK API] Ошибка в методе ${method}:`, data.error);
  }
  return data;
}

export interface VkUserInfo {
  id: number;
  first_name: string;
  last_name: string;
}

/** Получить имя+фамилию для списка пользователей одним запросом. */
export async function getUsersInfo(userIds: number[]): Promise<Map<number, VkUserInfo>> {
  const map = new Map<number, VkUserInfo>();
  const positiveIds = [...new Set(userIds.filter((id) => id > 0))];
  if (positiveIds.length === 0) return map;

  const data = await callVkApi("users.get", { user_ids: positiveIds.join(",") });
  for (const user of data.response ?? []) {
    map.set(user.id, { id: user.id, first_name: user.first_name, last_name: user.last_name });
  }
  return map;
}

/** Кликабельное упоминание пользователя в тексте сообщения VK: текст "Имя Фамилия" сам является ссылкой. */
export function profileLink(userId: number, name: string): string {
  return `[id${userId}|${name}]`;
}

/** Готовая ссылка-упоминание пользователя по его id (одиночный запрос имени). */
export async function nameLinkOf(userId: number): Promise<string> {
  const infoMap = await getUsersInfo([userId]);
  const info = infoMap.get(userId);
  const name = info ? `${info.first_name} ${info.last_name}` : `id${userId}`;
  return profileLink(userId, name);
}

export interface ConversationMember {
  memberId: number;
  isOwner: boolean;
  isAdmin: boolean;
}

/** Список участников беседы. Работает только для peer_id бесед (не для ЛС). */
export async function getConversationMembers(peerId: number): Promise<ConversationMember[]> {
  const data = await callVkApi("messages.getConversationMembers", { peer_id: String(peerId) });
  const items = data.response?.items ?? [];
  // deno-lint-ignore no-explicit-any
  return items.map((item: any) => ({
    memberId: item.member_id,
    isOwner: !!item.is_owner,
    isAdmin: !!item.is_admin,
  }));
}

/** peer_id >= 2_000_000_000 — это беседа (групповой чат), а не личные сообщения. */
export function isChatPeer(peerId: number): boolean {
  return peerId >= 2_000_000_000;
}

/** Переводит peer_id беседы в chat_id, нужный для messages.removeChatUser. */
export function toChatId(peerId: number): number {
  return peerId - 2_000_000_000;
}

/** Кикает пользователя из конкретной беседы. */
export async function kickFromChat(peerId: number, userId: number): Promise<void> {
  await callVkApi("messages.removeChatUser", {
    chat_id: String(toChatId(peerId)),
    member_id: String(userId),
  });
}

/** Резолвит короткое имя (screen_name) VK в числовой ID, если это пользователь. */
export async function resolveScreenName(screenName: string): Promise<number | null> {
  const data = await callVkApi("utils.resolveScreenName", { screen_name: screenName });
  if (data?.response?.type === "user") return Number(data.response.object_id);
  return null;
}

/**
 * Достаёт VK ID пользователя из аргумента команды. Понимает:
 * упоминание "[id123|Имя]", "@screenname", "screenname", "id123", "123",
 * ссылку вида "https://vk.com/screenname" или "https://vk.ru/id123".
 */
export async function resolveTargetUserId(raw: string): Promise<number | null> {
  let text = raw.trim();
  if (!text) return null;

  const bracketMatch = text.match(/\[id(\d+)\|/);
  if (bracketMatch) return Number(bracketMatch[1]);

  text = text.replace(/^https?:\/\/(www\.)?(vk\.com|vk\.ru)\//i, "");
  text = text.replace(/^@/, "");
  text = text.trim();

  const idMatch = text.match(/^id(\d+)$/i);
  if (idMatch) return Number(idMatch[1]);
  if (/^\d+$/.test(text)) return Number(text);

  if (text) return await resolveScreenName(text);
  return null;
}

export interface SentMessageIds {
  messageId?: number;
  conversationMessageId?: number;
}

/**
 * Отправляет сообщение (опционально — ответом на другое сообщение) и возвращает его ID.
 * Ответ messages.send в этой конфигурации ненадёжен (response: 0), поэтому ID
 * всегда достаём точным способом через messages.getHistory сразу после отправки.
 */
export async function sendMessageAndGetIds(
  peerId: number,
  text: string,
  options?: { keyboard?: string; replyToConversationMessageId?: number },
): Promise<SentMessageIds> {
  const params: Record<string, string> = {
    peer_id: String(peerId),
    message: text,
    random_id: String(Math.floor(Math.random() * 1e9)),
  };
  if (options?.keyboard) params.keyboard = options.keyboard;
  if (options?.replyToConversationMessageId) {
    params.forward = JSON.stringify({
      peer_id: peerId,
      conversation_message_ids: [options.replyToConversationMessageId],
      is_reply: true,
    });
  }

  await callVkApi("messages.send", params);

  const history = await callVkApi("messages.getHistory", { peer_id: String(peerId), count: "1" });
  const lastMessage = history?.response?.items?.[0];
  if (lastMessage?.out === 1) {
    const messageId = Number(lastMessage.id);
    const conversationMessageId = Number(lastMessage.conversation_message_id);
    return {
      messageId: Number.isNaN(messageId) || messageId <= 0 ? undefined : messageId,
      conversationMessageId:
        Number.isNaN(conversationMessageId) || conversationMessageId <= 0 ? undefined : conversationMessageId,
    };
  }
  return {};
}
