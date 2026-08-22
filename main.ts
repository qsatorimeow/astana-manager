// Бот 2 (astana-manager) — Deno Deploy + Upstash Redis
// ------------------------------------------------------
// Переменные окружения:
//   VK_TOKEN, VK_CONFIRMATION, VK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   DEVELOPER_IDS — VK ID разработчика(ов) через запятую; разработчик обходит все проверки
//
// Бот работает ТОЛЬКО в беседах (не в ЛС). Пока для беседы не пройдены
// /sync → /addgroup → /type, любые команды кроме этих трёх и /help не работают
// (кроме разработчика — он может использовать что угодно и где угодно).
//
// Каждый ответ бота отправляется реплаем на сообщение, вызвавшее команду.

import { redis } from "./kv.ts";
import {
  callVkApi,
  getUsersInfo,
  isChatPeer,
  kickFromChat,
  mention,
  parseUserIdFromMention,
  sendMessageAndGetIds,
} from "./vk.ts";
import {
  addChatRole,
  addGlobalRole,
  type AnyRole,
  type ChatRole,
  type GlobalRole,
  hasAtLeastRole,
  isDeveloperId,
  removeChatRole,
  removeGlobalRole,
  resolveUserRole,
  ROLE_LABEL,
} from "./roles.ts";
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
import {
  clearChatBan,
  clearGlobalBan,
  clearMute,
  clearSeniorBan,
  getAllSeniorBans,
  getBanHistory,
  getChatBan,
  getGlobalBan,
  isMuted,
  isSeniorBannedInChat,
  isTimeoutActive,
  kickFromAllSyncedChats,
  kickFromOwnerGroups,
  logBanEvent,
  setChatBan,
  setGlobalBan,
  setMute,
  setSeniorBan,
  setTimeoutMode,
  trackFloodAndShouldKick,
} from "./moderation.ts";
import { findUserIdByNick, getNickFor, listNicks, removeNickFor, setNickFor } from "./nicknames.ts";
import { ALT_MAP, buildHelpMessage, buildStaffMessage } from "./staff.ts";

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

async function reply(peerId: number, replyToCmid: number, text: string) {
  await sendMessageAndGetIds(peerId, text, { replyToConversationMessageId: replyToCmid });
}

function formatMsk(ms: number): string {
  const mskDate = new Date(ms + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${mskDate.getUTCFullYear()}-${pad(mskDate.getUTCMonth() + 1)}-${pad(mskDate.getUTCDate())} ` +
    `${pad(mskDate.getUTCHours())}:${pad(mskDate.getUTCMinutes())}:${pad(mskDate.getUTCSeconds())} МСК (UTC+3)`;
}

async function nameOf(userId: number): Promise<string> {
  const infoMap = await getUsersInfo([userId]);
  return mention(userId, infoMap.get(userId));
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
          {
            action: {
              type: "callback",
              label: "Административный чат",
              payload: JSON.stringify({ action: "set_type", value: "admin" }),
            },
            color: "primary",
          },
          {
            action: {
              type: "callback",
              label: "Беседа игроков",
              payload: JSON.stringify({ action: "set_type", value: "player" }),
            },
            color: "primary",
          },
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

// --- Генерическая таблица команд назначения рангов ---

interface RankCommandConfig {
  requiredRole: AnyRole;
  action: "add" | "remove";
  role: GlobalRole | ChatRole;
  scope: "global" | "chat";
}

const RANK_COMMANDS: Record<string, RankCommandConfig> = {
  "/addsa": { requiredRole: "developer", action: "add", role: "spec_admin", scope: "global" },
  "/delsa": { requiredRole: "developer", action: "remove", role: "spec_admin", scope: "global" },
  "/addzsa": { requiredRole: "spec_admin", action: "add", role: "deputy_spec_admin", scope: "global" },
  "/delzsa": { requiredRole: "spec_admin", action: "remove", role: "deputy_spec_admin", scope: "global" },
  "/addsenadmin": { requiredRole: "deputy_spec_admin", action: "add", role: "senior_admin", scope: "chat" },
  "/delsenadmin": { requiredRole: "deputy_spec_admin", action: "remove", role: "senior_admin", scope: "chat" },
  "/addadmin": { requiredRole: "senior_admin", action: "add", role: "admin", scope: "chat" },
  "/deladmin": { requiredRole: "senior_admin", action: "remove", role: "admin", scope: "chat" },
  "/addsenmoder": { requiredRole: "admin", action: "add", role: "senior_moderator", scope: "chat" },
  "/delsenmoder": { requiredRole: "admin", action: "remove", role: "senior_moderator", scope: "chat" },
  "/addmoder": { requiredRole: "senior_moderator", action: "add", role: "moderator", scope: "chat" },
  "/delmoder": { requiredRole: "senior_moderator", action: "remove", role: "moderator", scope: "chat" },
};

async function handleRankCommand(peerId: number, fromId: number, cmid: number, command: string, args: string[]): Promise<boolean> {
  const cfg = RANK_COMMANDS[command];
  if (!cfg) return false;

  if (!(await hasAtLeastRole(peerId, fromId, cfg.requiredRole))) {
    await reply(peerId, cmid, "Недостаточно прав для этой команды.");
    return true;
  }

  const targetId = parseUserIdFromMention(args.join(" "));
  if (!targetId) {
    await reply(peerId, cmid, `Формат: ${command} @пользователь`);
    return true;
  }

  if (cfg.scope === "global") {
    if (cfg.action === "add") await addGlobalRole(cfg.role as GlobalRole, targetId);
    else await removeGlobalRole(cfg.role as GlobalRole, targetId);
  } else {
    if (cfg.action === "add") await addChatRole(peerId, cfg.role as ChatRole, targetId);
    else await removeChatRole(peerId, cfg.role as ChatRole, targetId);
  }

  await reply(peerId, cmid, cfg.action === "add" ? "✅ Ранг назначен." : "➖ Ранг снят.");
  return true;
}

// --- Остальные команды (требуют полной настройки чата) ---

interface ReplyContext {
  fromId: number;
  conversationMessageId: number;
}

async function handleCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  command: string,
  args: string[],
  replyToMessage: ReplyContext | null,
) {
  // Назначение/снятие рангов — общая таблица
  if (await handleRankCommand(peerId, fromId, cmid, command, args)) return;

  switch (command) {
    case "/help": {
      const { weight } = await resolveUserRole(peerId, fromId);
      await reply(peerId, cmid, buildHelpMessage(weight));
      break;
    }

    case "/alt": {
      await reply(
        peerId,
        cmid,
        [
          "Альтернативные названия команд:",
          "/clear — чистка",
          "/staff — стафф",
          "/getnick — gnick, никлист",
          "/setnick — snick",
          "/removenick — rnick",
          "/nlist — ники",
          "/getacc — аккаунт",
          "/getban — чекбан",
          "/kick — кик",
          "/mute — мут, заткнуть",
          "/unmute — размут, разоткнуть",
        ].join("\n"),
      );
      break;
    }

    case "/staff": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      await reply(peerId, cmid, await buildStaffMessage(peerId));
      break;
    }

    // --- Экономика ---

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
      const nick = await getNickFor(peerId, fromId);
      const name = await nameOf(fromId);
      const lines = [
        `Информация о пользователе ${name}`,
        `Роль: ${ROLE_LABEL[role.role]}`,
        `Баланс: ${balance} монет`,
        `Ник: ${nick ?? "Нет"}`,
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

    // --- Баны и кики ---

    case "/ban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) {
        await reply(peerId, cmid, "Команда доступна старшему модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /ban @пользователь причина"); return; }
      await setChatBan(peerId, targetId, reason);
      await logBanEvent(targetId, { type: "ban", peerId, reason, byUserId: fromId, at: Date.now() });
      await kickFromChat(peerId, targetId);
      await reply(peerId, cmid, `🚫 ${await nameOf(targetId)} забанен и кикнут из беседы. Причина: ${reason}`);
      break;
    }

    case "/unban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) {
        await reply(peerId, cmid, "Команда доступна старшему администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /unban @пользователь причина"); return; }
      await clearChatBan(peerId, targetId);
      await logBanEvent(targetId, { type: "unban", peerId, reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `✅ Бан снят с ${await nameOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/sban": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) {
        await reply(peerId, cmid, "Команда доступна администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /sban @пользователь причина"); return; }
      await setSeniorBan(fromId, targetId, reason);
      await logBanEvent(targetId, { type: "sban", reason, byUserId: fromId, at: Date.now() });
      const count = await kickFromOwnerGroups(fromId, targetId);
      await reply(peerId, cmid, `🚫 ${await nameOf(targetId)} забанен во всех ваших беседах (${count}). Причина: ${reason}`);
      break;
    }

    case "/sunban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) {
        await reply(peerId, cmid, "Команда доступна старшему администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /sunban @пользователь причина"); return; }
      await clearSeniorBan(fromId, targetId);
      await logBanEvent(targetId, { type: "sunban", reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `✅ Бан во всех ваших беседах снят с ${await nameOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/gban": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, "Команда доступна спец. и зам. спец. администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /gban @пользователь причина"); return; }
      await setGlobalBan(targetId, reason);
      await logBanEvent(targetId, { type: "gban", reason, byUserId: fromId, at: Date.now() });
      const count = await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `🚫 ${await nameOf(targetId)} забанен глобально (${count} чатов). Причина: ${reason}`);
      break;
    }

    case "/gunban": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, "Команда доступна спец. и зам. спец. администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /gunban @пользователь причина"); return; }
      await clearGlobalBan(targetId);
      await logBanEvent(targetId, { type: "gunban", reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `✅ Глобальный бан снят с ${await nameOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/getban": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "") ?? fromId;
      const [globalBan, seniorBans, chatBan] = await Promise.all([
        getGlobalBan(targetId),
        getAllSeniorBans(targetId),
        getChatBan(peerId, targetId),
      ]);
      const lines = [`Информация о блокировках пользователя ${await nameOf(targetId)}`, ""];
      lines.push(`Глобальная блокировка (/gban) — ${globalBan ? `есть, причина: ${globalBan}` : "отсутствует"}`);
      lines.push(
        seniorBans.length
          ? `Блокировки от старших администраторов (/sban) — ${seniorBans.length} шт.`
          : "Блокировки от старших администраторов (/sban) — отсутствуют",
      );
      lines.push(`Блокировка в этой беседе (/ban) — ${chatBan ? `есть, причина: ${chatBan}` : "отсутствует"}`);
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/banlist": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) {
        await reply(peerId, cmid, "Команда доступна старшему модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "") ?? fromId;
      const history = await getBanHistory(targetId);
      if (history.length === 0) {
        await reply(peerId, cmid, `У ${await nameOf(targetId)} нет истории блокировок.`);
        return;
      }
      const lines = [`История блокировок ${await nameOf(targetId)}:`];
      for (const h of history.slice(-15)) {
        lines.push(`${h.type} | ${formatMsk(h.at)} | от ${await nameOf(h.byUserId)} | ${h.reason}`);
      }
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/kick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /kick @пользователь причина"); return; }
      await logBanEvent(targetId, { type: "kick", peerId, reason, byUserId: fromId, at: Date.now() });
      await kickFromChat(peerId, targetId);
      await reply(peerId, cmid, `👢 ${await nameOf(targetId)} кикнут. Причина: ${reason}`);
      break;
    }

    case "/skick": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) {
        await reply(peerId, cmid, "Команда доступна администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /skick @пользователь причина"); return; }
      await logBanEvent(targetId, { type: "skick", reason, byUserId: fromId, at: Date.now() });
      const count = await kickFromOwnerGroups(fromId, targetId);
      await reply(peerId, cmid, `👢 ${await nameOf(targetId)} кикнут из ваших бесед (${count}). Причина: ${reason}`);
      break;
    }

    case "/gkick": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, "Команда доступна спец. и зам. спец. администратору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /gkick @пользователь причина"); return; }
      await logBanEvent(targetId, { type: "gkick", reason, byUserId: fromId, at: Date.now() });
      const count = await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `👢 ${await nameOf(targetId)} кикнут из всех бесед бота (${count}). Причина: ${reason}`);
      break;
    }

    // --- Мут / тайм-аут / очистка ---

    case "/mute": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const minutes = Number(args[1]);
      const reason = args.slice(2).join(" ") || "не указана";
      if (!targetId || !minutes) { await reply(peerId, cmid, "Формат: /mute @пользователь минуты причина"); return; }
      await setMute(peerId, targetId, minutes);
      await reply(peerId, cmid, `🔇 ${await nameOf(targetId)} замучен на ${minutes} мин. Причина: ${reason}`);
      break;
    }

    case "/unmute": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const reason = args.slice(1).join(" ") || "не указана";
      if (!targetId) { await reply(peerId, cmid, "Формат: /unmute @пользователь причина"); return; }
      await clearMute(peerId, targetId);
      await reply(peerId, cmid, `🔊 Мут снят с ${await nameOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/timeout": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) {
        await reply(peerId, cmid, "Команда доступна администратору.");
        return;
      }
      const active = await isTimeoutActive(peerId);
      await setTimeoutMode(peerId, !active);
      await reply(peerId, cmid, !active ? "🔇 Режим тишины включён." : "🔊 Режим тишины выключен.");
      break;
    }

    case "/clear": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      if (!replyToMessage) {
        await reply(peerId, cmid, "Используйте /clear ответом на сообщение, которое нужно удалить.");
        return;
      }
      const targetRole = await resolveUserRole(peerId, replyToMessage.fromId);
      const myRole = await resolveUserRole(peerId, fromId);
      if (targetRole.weight >= myRole.weight && replyToMessage.fromId !== fromId) {
        await reply(peerId, cmid, "Нельзя удалить сообщение пользователя с равным или более высоким рангом.");
        return;
      }
      await callVkApi("messages.delete", {
        peer_id: String(peerId),
        cmids: String(replyToMessage.conversationMessageId),
        delete_for_all: "1",
      });
      break;
    }

    // --- Ники ---

    case "/setnick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      const nick = args.slice(1).join(" ");
      if (!targetId || !nick) { await reply(peerId, cmid, "Формат: /setnick @пользователь ник"); return; }
      await setNickFor(peerId, targetId, nick);
      await reply(peerId, cmid, `✏️ Ник для ${await nameOf(targetId)} установлен: ${nick}`);
      break;
    }

    case "/removenick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      if (!targetId) { await reply(peerId, cmid, "Формат: /removenick @пользователь"); return; }
      await removeNickFor(peerId, targetId);
      await reply(peerId, cmid, `🗑 Ник для ${await nameOf(targetId)} убран.`);
      break;
    }

    case "/getnick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const targetId = parseUserIdFromMention(args[0] ?? "");
      if (!targetId) { await reply(peerId, cmid, "Формат: /getnick @пользователь"); return; }
      const nick = await getNickFor(peerId, targetId);
      await reply(peerId, cmid, nick ? `Ник: ${nick}` : "У пользователя нет ника.");
      break;
    }

    case "/getacc": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const nick = args.join(" ");
      if (!nick) { await reply(peerId, cmid, "Формат: /getacc Ник"); return; }
      const userId = await findUserIdByNick(peerId, nick);
      await reply(peerId, cmid, userId ? `Профиль: https://vk.com/id${userId}` : "Ник не найден.");
      break;
    }

    case "/nlist": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
        await reply(peerId, cmid, "Команда доступна модератору.");
        return;
      }
      const nicks = await listNicks(peerId);
      if (nicks.length === 0) { await reply(peerId, cmid, "В чате нет ников."); return; }
      const lines = ["Пользователи с ником:"];
      let i = 1;
      for (const n of nicks) lines.push(`${i++}) ${await nameOf(n.userId)} — ${n.nick}`);
      await reply(peerId, cmid, lines.join("\n"));
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

  // Мут: сообщения замученного удаляются молча, команды не обрабатываются.
  if (await isMuted(peerId, fromId)) {
    await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
    return;
  }

  // Режим тишины: пишут только модератор и выше.
  if (await isTimeoutActive(peerId)) {
    const isStaff = await hasAtLeastRole(peerId, fromId, "moderator");
    if (!isStaff) {
      await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
      return;
    }
  }

  if (text.startsWith("/")) {
    let [command, ...args] = text.split(/\s+/);
    command = command.toLowerCase();

    // Альтернативные названия команд
    const altTarget = ALT_MAP[command.slice(1)];
    if (altTarget) command = altTarget;

    const handledAsSetup = await handleSetupCommand(peerId, fromId, cmid, command, args);
    if (handledAsSetup) return;

    if (command === "/help" || command === "/alt") {
      const replyToMessage = message.reply_message
        ? { fromId: message.reply_message.from_id, conversationMessageId: message.reply_message.conversation_message_id }
        : null;
      await handleCommand(peerId, fromId, cmid, command, args, replyToMessage);
      return;
    }

    if (!isDeveloperId(fromId) && !(await isChatConfigured(peerId))) {
      await reply(peerId, cmid, await getConfigStatusMessage(peerId));
      return;
    }

    const replyToMessage = message.reply_message
      ? { fromId: message.reply_message.from_id, conversationMessageId: message.reply_message.conversation_message_id }
      : null;
    await handleCommand(peerId, fromId, cmid, command, args, replyToMessage);
    return;
  }

  // Обычное (не команда) сообщение — считаем для экономики и антифлуда, если чат настроен.
  if (await isChatConfigured(peerId)) {
    await trackMessage(peerId, fromId);

    const shouldKick = await trackFloodAndShouldKick(peerId, fromId, text);
    if (shouldKick) {
      await kickFromChat(peerId, fromId);
      await sendMessageAndGetIds(peerId, `👢 ${await nameOf(fromId)} кикнут за флуд.`);
    }
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
    } else if (body.type === "chat_invite_user") {
      // Повторный кик забаненного, если его пригласили обратно.
      const obj = body.object;
      const peerId = obj.chat_id ? obj.chat_id + 2_000_000_000 : obj.peer_id;
      const userId = obj.user_id;
      if (peerId && userId) {
        const [globalBan, chatBan, seniorBan] = await Promise.all([
          getGlobalBan(userId),
          getChatBan(peerId, userId),
          isSeniorBannedInChat(peerId, userId),
        ]);
        if (globalBan || chatBan || seniorBan) {
          await kickFromChat(peerId, userId);
        }
      }
    }
  } catch (e) {
    console.error("Ошибка обработки события:", e);
  }

  return new Response("ok", { status: 200 });
});
