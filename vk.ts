// Вспомогательные функции для работы с VK API.

const VK_TOKEN = Deno.env.get("VK_TOKEN") ?? "";
const VK_API_VERSION = "5.199";

export async function callVkApi(method: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, access_token: VK_TOKEN, v: VK_API_VERSION });
  const res = await fetch(`https://api.vk.com/method/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (data.error) console.error(`[VK API] Ошибка в методе ${method}:`, data.error);
  return data;
}

export interface VkUserInfo { id: number; first_name: string; last_name: string; }

export async function getUsersInfo(userIds: number[]): Promise<Map<number, VkUserInfo>> {
  const map = new Map<number, VkUserInfo>();
  const ids = [...new Set(userIds.filter((id) => id > 0))];
  if (!ids.length) return map;
  const data = await callVkApi("users.get", { user_ids: ids.join(",") });
  for (const user of data.response ?? []) map.set(user.id, { id: user.id, first_name: user.first_name, last_name: user.last_name });
  return map;
}

export function profileLink(userId: number, name: string): string { return `[id${userId}|${name}]`; }

export async function nameLinkOf(userId: number): Promise<string> {
  const info = (await getUsersInfo([userId])).get(userId);
  return profileLink(userId, info ? `${info.first_name} ${info.last_name}` : `id${userId}`);
}

export interface ConversationMember { memberId: number; isOwner: boolean; isAdmin: boolean; }

export async function getConversationMembers(peerId: number): Promise<ConversationMember[]> {
  const data = await callVkApi("messages.getConversationMembers", { peer_id: String(peerId) });
  return (data.response?.items ?? []).map((x: any) => ({ memberId: Number(x.member_id), isOwner: !!x.is_owner, isAdmin: !!x.is_admin }));
}

export function isChatPeer(peerId: number): boolean { return peerId >= 2_000_000_000; }
export function toChatId(peerId: number): number { return peerId - 2_000_000_000; }

export async function kickFromChat(peerId: number, userId: number): Promise<void> {
  await callVkApi("messages.removeChatUser", { chat_id: String(toChatId(peerId)), member_id: String(userId) });
}

export async function resolveScreenName(screenName: string): Promise<number | null> {
  const data = await callVkApi("utils.resolveScreenName", { screen_name: screenName });
  return data?.response?.type === "user" ? Number(data.response.object_id) : null;
}

export async function resolveTargetUserId(raw: string): Promise<number | null> {
  let text = raw.trim();
  if (!text) return null;
  const mention = text.match(/\[id(\d+)\|/);
  if (mention) return Number(mention[1]);
  text = text.replace(/^https?:\/\/(www\.)?(vk\.com|vk\.ru)\//i, "").replace(/^@/, "").trim();
  const id = text.match(/^id(\d+)$/i);
  if (id) return Number(id[1]);
  if (/^\d+$/.test(text)) return Number(text);
  return await resolveScreenName(text);
}

export interface SentMessageIds { messageId?: number; conversationMessageId?: number; }

export async function sendMessageAndGetIds(
  peerId: number,
  text: string,
  options?: { keyboard?: string; replyToConversationMessageId?: number },
): Promise<SentMessageIds> {
  const params: Record<string, string> = {
    peer_id: String(peerId),
    message: text,
    random_id: String(Math.floor(Math.random() * 2_000_000_000) - 1_000_000_000),
  };
  if (options?.keyboard) params.keyboard = options.keyboard;
  if (options?.replyToConversationMessageId) {
    params.forward = JSON.stringify({
      peer_id: peerId,
      conversation_message_ids: [options.replyToConversationMessageId],
      is_reply: true,
    });
  }

  const sent = await callVkApi("messages.send", params);
  const directMessageId = Number(sent?.response ?? 0);

  if (directMessageId > 0) {
    const byId = await callVkApi("messages.getById", { message_ids: String(directMessageId) });
    const item = byId?.response?.items?.[0];
    if (item) {
      return {
        messageId: directMessageId,
        conversationMessageId: Number(item.conversation_message_id) || undefined,
      };
    }
    return { messageId: directMessageId };
  }

  // В некоторых конфигурациях VK возвращает response: 0 даже при успешной отправке.
  // В таком случае ищем последнее исходящее сообщение с тем же текстом.
  const history = await callVkApi("messages.getHistory", { peer_id: String(peerId), count: "20" });
  const item = (history?.response?.items ?? []).find((x: any) => x.out === 1 && String(x.text ?? "") === text);
  if (item) {
    return {
      messageId: Number(item.id) || undefined,
      conversationMessageId: Number(item.conversation_message_id) || undefined,
    };
  }

  console.error(`[VK] Не удалось получить ID отправленного сообщения peer=${peerId}`);
  return {};
}
