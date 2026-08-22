// Бот 2 (astana-manager) — Deno Deploy + Upstash Redis
// ------------------------------------------------------
// Переменные окружения:
//   VK_TOKEN, VK_CONFIRMATION, VK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   DEVELOPER_IDS — VK ID разработчика(ов) через запятую
//
// Бот работает ТОЛЬКО в беседах (не в ЛС). Пока для беседы не пройдены
// /sync → /addgroup → /type, любые команды кроме этих трёх и /help не работают.
//
// Реализовано в этом слое: /sync /delsync /synclist /addgroup /delgroup /mygroups
// /type /help /staff (базовый) /reward /balance /stats /pay /top /gtop.
// Административная лестница (баны/кики/назначение рангов/мут/ники) — следующим слоем.

import { redis } from "./kv.ts";
import { callVkApi, getUsersInfo, isChatPeer, mention, parseUserIdFromMention, sendMessageAndGetIds } from "./vk.ts";
import { hasAtLeastRole, resolveUserRole, ROLE_LABEL } from "./roles.ts";
import {
  addGroup,
  buildSyncListMessage,
  CHAT_TYPE_LABEL,
  clearSync,
  getConfigStatusMessage,
  getOwnerGroups,
  isChatConfigured,
  removeGroup,
  setChatType,
  setSync,
} from "./setup.ts";
import {
  formatTopList,
  getBalance,
  getChatTop,
  getGlobalTop,
  getMessageStats,
  trackMessage,
  transferBalance,
  tryClaimReward,
} from "./economy.ts";

const VK_CONFIRMATION = Deno.env.get("VK_CONFIRMATION") ?? "";
const VK_SECRET = Deno.env.get("VK_SECRET") ?? "";

async function alreadyProcessed(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return false;
  const key = `vk:event:${eventId}`;
  const seen = await redis.get(key);
  if (seen) return true;
  await redis.set(key, "1", { ex: 3600 });
  return false;
}

/** Все ответы бота на команды идут "ответом" на исходное сообщение. */
async function reply(peerId: number, replyToCmid: number, text: string) {
  await sendMessageAndGetIds(peerId, text, { replyToConversationMessageId: replyToCmid });
}

function formatMsk(ms: number): string {
  const mskDate = new Date(ms + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${mskDate.getUTCFullYear()}-${pad(mskDate.getUTCMonth() + 1)}-${pad(mskDate.getUTCDate())} ` +
    `${pad(mskDate.getUTCHours())}:${pad(mskDate.getUTCMinutes())}:${pad(mskDate.getUTCSeconds())} МСК (UTC+3)`;
}

// --- Команды настройки (работают даже до полной конфигурации чата) ---

async function handleSetupCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  command: string,
  args: string[],
): Promise<boolean> {
  switch (command) {
    case "/sync": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, "Команда доступна спец. и зам. спец. администратору.");
        return true;
      }
      await setSync(peerId, fromId);
      await reply(peerId, cmid, "✅ Синхронизация с базой данных прошла успешно!");
      return true;
    }

    case "/delsync": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, "Команда доступна спец. и зам. спец. администратору.");
        return true;
      }
      await clearSync(peerId);
      await reply(peerId, cmid, "🗑 Синхронизация с базой данных удалена.");
      return true;
    }

    case "/synclist": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, "Команда доступна спец. и зам. спец. администратору.");
        return true;
      }
      await reply(peerId, cmid, await buildSyncListMessage());
      return true;
    }

    case "/addgroup": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) {
        await reply(peerId, cmid, "Команда доступна старшему администратору.");
        return true;
      }
      const targetPeer = args[0] ? Number(args[0]) : peerId;
      await addGroup(targetPeer, fromId);
      await reply(peerId, cmid, "✅ Данная беседа добавлена в список ваших чатов.");
      return true;
    }

    case "/delgroup": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) {
        await reply(peerId, cmid, "Команда доступна старшему администратору.");
        return true;
      }
      const targetPeer = args[0] ? Number(args[0]) : peerId;
      await removeGroup(targetPeer, fromId);
      await reply(peerId, cmid, "🗑 Данная беседа удалена из списка ваших чатов.");
      return true;
    }

    case "/mygroups": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) {
        await reply(peerId, cmid, "Команда доступна старшему администратору.");
        return true;
      }
      const groups = await getOwnerGroups(fromId);
      const text = groups.length > 0
        ? ["Список ваших чатов:", ...groups.map((g) => `Чат | ${g}`)].join("\n")
        : "У вас нет привязанных чатов.";
      await reply(peerId, cmid, text);
      return true;
    }

    case "/type": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) {
        await reply(peerId, cmid, "Команда доступна старшему администратору.");
        return true;
      }
      const keyboard = JSON.stringify({
        inline: true,
        buttons: [[
          { action: { type: "callback", label: "Административный чат", payload: JSON.stringify({ action: "set_type", value: "admin" }) }, color: "primary" },
          { action: { type: "callback", label: "Беседа игроков", payload: JSON.stringify({ action: "set_type", value: "player" }) }, color: "primary" },
        ]],
      });
      await sendMessageAndGetIds(peerId, "Выберите тип беседы:\n1. Административный чат\n2. Беседа игроков", {
        keyboard,
        replyToConversationMessageId: cmid,
      });
      return true;
    }

    default:
      return false;
  }
}

// --- Остальные команды (требуют полной настройки чата) ---

async function handleCommand(peerId: number, fromId: number, cmid: number, command: string, args: string[]) {
  switch (command) {
    case "/help": {
      await reply(peerId, cmid, "📖 Список команд появится здесь по мере готовности следующих разделов бота.");
      break;
    }

    case "/staff": {
      await reply(
        peerId,
        cmid,
        "🛡 Полная версия /staff (со списком всех рангов беседы) появится на следующем этапе.",
      );
      break;
    }

    case "/reward": {
      const result = await tryClaimReward(fromId);
      if (result.ok) {
        await reply(peerId, cmid, `🪙 Вы получили ${result.amount} монет!`);
      } else {
        const minutesLeft = Math.ceil(result.msLeft / 60000);
        await reply(peerId, cmid, `⏳ Следующая награда будет доступна через ${minutesLeft} мин.`);
      }
      break;
    }

    case "/balance": {
      const balance = await getBalance(fromId);
      await reply(peerId, cmid, `💰 Ваш баланс: ${balance} монет.`);
      break;
    }

    case "/stats": {
      const [role, stats] = await Promise.all([
        resolveUserRole(peerId, fromId),
        getMessageStats(peerId, fromId),
      ]);
      const balance = await getBalance(fromId);
      const infoMap = await getUsersInfo([fromId]);
      const name = mention(fromId, infoMap.get(fromId));
      const lines = [
        `Информация о пользователе ${name}`,
        `Роль: ${ROLE_LABEL[role.role]}`,
        `Баланс: ${balance} монет`,
        `Всего сообщений: ${stats.count}`,
        `Последнее сообщение: ${stats.lastMessageMs ? formatMsk(stats.lastMessageMs) : "нет данных"}`,
      ];
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/pay": {
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const amount = Number(args[1]);
      if (!targetId || !amount || amount <= 0) {
        await reply(peerId, cmid, "Формат: /pay @пользователь количество");
        return;
      }
      const ok = await transferBalance(fromId, targetId, amount);
      await reply(peerId, cmid, ok ? `✅ Вы передали ${amount} монет.` : "⚠️ Недостаточно монет на балансе.");
      break;
    }

    case "/top": {
      const entries = await getChatTop(peerId);
      await reply(peerId, cmid, `🏆 Топ по балансу в чате:\n${await formatTopList(entries)}`);
      break;
    }

    case "/gtop": {
      const entries = await getGlobalTop();
      await reply(peerId, cmid, `🏆 Топ по балансу среди всех пользователей:\n${await formatTopList(entries)}`);
      break;
    }

    default:
      break; // бот отвечает только на свои команды
  }
}

// --- Нажатия кнопок (выбор типа беседы) ---

// deno-lint-ignore no-explicit-any
async function handleMessageEvent(body: any) {
  const obj = body.object;
  const peerId = obj.peer_id;
  const userId = obj.user_id;
  if (!isChatPeer(peerId)) return;

  await callVkApi("messages.sendMessageEventAnswer", {
    event_id: obj.event_id,
    user_id: String(userId),
    peer_id: String(peerId),
  });

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = typeof obj.payload === "string" ? JSON.parse(obj.payload) : obj.payload ?? {};
  } catch {
    return;
  }

  if (payload.action === "set_type" && (payload.value === "admin" || payload.value === "player")) {
    if (!(await hasAtLeastRole(peerId, userId, "senior_admin"))) return;
    await setChatType(peerId, payload.value);
    await callVkApi("messages.edit", {
      peer_id: String(peerId),
      conversation_message_id: String(obj.conversation_message_id),
      message: `Вы установили тип беседы "${CHAT_TYPE_LABEL[payload.value as "admin" | "player"]}"`,
    });
  }
}

// --- Новые сообщения ---

// deno-lint-ignore no-explicit-any
async function handleMessageNew(body: any) {
  const message = body.object.message;
  if (message.out === 1) return;

  const peerId = message.peer_id;
  if (!isChatPeer(peerId)) return; // бот работает только в беседах, ЛС полностью игнорируются

  const fromId = message.from_id;
  const text = (message.text ?? "").trim();
  const cmid = message.conversation_message_id;

  if (text.startsWith("/")) {
    const [command, ...args] = text.split(/\s+/);
    const lowerCommand = command.toLowerCase();

    const handledAsSetup = await handleSetupCommand(peerId, fromId, cmid, lowerCommand, args);
    if (handledAsSetup) return;

    if (lowerCommand === "/help") {
      await handleCommand(peerId, fromId, cmid, lowerCommand, args);
      return;
    }

    if (!(await isChatConfigured(peerId))) {
      await reply(peerId, cmid, await getConfigStatusMessage(peerId));
      return;
    }

    await handleCommand(peerId, fromId, cmid, lowerCommand, args);
    return;
  }

  // Обычное (не команда) сообщение — считаем для экономики, если чат настроен.
  if (await isChatConfigured(peerId)) {
    await trackMessage(peerId, fromId);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Bot 2 (astana-manager) is running", { status: 200 });
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (body.type === "confirmation") {
    return new Response(VK_CONFIRMATION, { status: 200 });
  }

  if (VK_SECRET && body.secret !== undefined && body.secret !== VK_SECRET) {
    return new Response("invalid secret", { status: 403 });
  }

  if (await alreadyProcessed(body.event_id)) {
    return new Response("ok", { status: 200 });
  }

  try {
    if (body.type === "message_new") {
      await handleMessageNew(body);
    } else if (body.type === "message_event") {
      await handleMessageEvent(body);
    }
  } catch (e) {
    console.error("Ошибка обработки события:", e);
  }

  return new Response("ok", { status: 200 });
});
