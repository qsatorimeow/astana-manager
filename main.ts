// Бот 2 (astana-manager) — Deno Deploy + Upstash Redis
// ------------------------------------------------------
// Переменные окружения:
//   VK_TOKEN, VK_CONFIRMATION, VK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   DEVELOPER_IDS — VK ID разработчика(ов) через запятую; разработчик обходит все проверки
//
// Бот работает ТОЛЬКО в беседах (не в ЛС). Пока для беседы не пройдены
// /sync → /addgroup → /type, любые команды кроме этих трёх не работают
// (кроме разработчика — он может использовать что угодно и где угодно).
// Символы вызова команды: / + !
//
// Цель команды можно указать: упоминанием, "@screenname", "screenname",
// "id123", просто "123", ссылкой на профиль, или вообще не указывать —
// тогда берётся автор сообщения, на которое сделан ответ (reply).
//
// Каждый ответ бота отправляется реплаем на сообщение, вызвавшее команду.

import { redis } from "./kv.ts";
import {
  callVkApi,
  isChatPeer,
  kickFromChat,
  nameLinkOf,
  resolveTargetUserId,
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
  getGroupOwner,
  getOwnerGroups,
  isChatConfigured,
  isGroupAdded,
  isSynced,
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
  type BanRecord,
  clearChatBan,
  clearGlobalBan,
  clearMute,
  clearSeniorBan,
  getActiveBanForChat,
  getAllSeniorBans,
  getBanHistory,
  getChatBan,
  getGlobalBan,
  isMuted,
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
const NO_PERMISSION = "Недостаточно прав!";
const NO_TARGET = "Вы не указали пользователя";

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

interface ReplyContext {
  fromId: number;
  conversationMessageId: number;
}

/**
 * Определяет цель команды: сначала пробует явный аргумент (упоминание/ник/ссылка/id),
 * если не получилось — берёт автора сообщения, на которое дан ответ.
 * Возвращает найденный id и оставшиеся аргументы (без потраченного на цель).
 */
async function extractTarget(
  args: string[],
  replyToMessage: ReplyContext | null,
): Promise<{ targetId: number | null; rest: string[] }> {
  if (args.length > 0) {
    const resolved = await resolveTargetUserId(args[0]);
    if (resolved) return { targetId: resolved, rest: args.slice(1) };
  }
  if (replyToMessage) return { targetId: replyToMessage.fromId, rest: args };
  return { targetId: null, rest: args };
}

/** Может ли actor воздействовать на target (разработчик — всегда; иначе ранг строго выше). */
async function canActOn(peerId: number, actorId: number, targetId: number): Promise<boolean> {
  if (isDeveloperId(actorId)) return true;
  if (actorId === targetId) return true;
  const [actor, target] = await Promise.all([
    resolveUserRole(peerId, actorId),
    resolveUserRole(peerId, targetId),
  ]);
  return actor.weight > target.weight;
}

function formatBanEntry(record: BanRecord, byName: string): string {
  return `${byName} | ${record.reason} | ${formatMsk(record.at)}`;
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
        await reply(peerId, cmid, NO_PERMISSION);
        return true;
      }
      if (await isSynced(peerId)) {
        await reply(peerId, cmid, "Эта беседа уже синхронизирована.");
        return true;
      }
      await setSync(peerId, fromId);
      await reply(peerId, cmid, "Синхронизация с базой данных прошла успешно!");
      return true;
    }

    case "/delsync": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, NO_PERMISSION);
        return true;
      }
      await clearSync(peerId);
      await reply(peerId, cmid, "Синхронизация с базой данных удалена.");
      return true;
    }

    case "/synclist": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) {
        await reply(peerId, cmid, NO_PERMISSION);
        return true;
      }
      await reply(peerId, cmid, await buildSyncListMessage());
      return true;
    }

    case "/addgroup": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) {
        await reply(peerId, cmid, NO_PERMISSION);
        return true;
      }
      const targetPeer = args[0] ? Number(args[0]) : peerId;
      if (await isGroupAdded(targetPeer)) {
        await reply(peerId, cmid, "Эта беседа уже привязана. Сначала нужно её отвязать (/delgroup).");
        return true;
      }
      await addGroup(targetPeer, fromId);
      await reply(peerId, cmid, "Данная беседа добавлена в список ваших чатов.");
      return true;
    }

    case "/delgroup": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) {
        await reply(peerId, cmid, NO_PERMISSION);
        return true;
      }
      const targetPeer = args[0] ? Number(args[0]) : peerId;
      const owner = await getGroupOwner(targetPeer);
      if (owner !== null && owner !== fromId && !isDeveloperId(fromId)) {
        await reply(peerId, cmid, NO_PERMISSION);
        return true;
      }
      await removeGroup(targetPeer, owner ?? fromId);
      await reply(peerId, cmid, "Данная беседа удалена из списка ваших чатов.");
      return true;
    }

    case "/mygroups": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) {
        await reply(peerId, cmid, NO_PERMISSION);
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
        await reply(peerId, cmid, NO_PERMISSION);
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

async function handleRankCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  command: string,
  args: string[],
  replyToMessage: ReplyContext | null,
): Promise<boolean> {
  const cfg = RANK_COMMANDS[command];
  if (!cfg) return false;

  if (!(await hasAtLeastRole(peerId, fromId, cfg.requiredRole))) {
    await reply(peerId, cmid, NO_PERMISSION);
    return true;
  }

  const { targetId } = await extractTarget(args, replyToMessage);
  if (!targetId) {
    await reply(peerId, cmid, NO_TARGET);
    return true;
  }

  if (!(await canActOn(peerId, fromId, targetId))) {
    await reply(peerId, cmid, NO_PERMISSION);
    return true;
  }

  if (cfg.scope === "global") {
    if (cfg.action === "add") await addGlobalRole(cfg.role as GlobalRole, targetId);
    else await removeGlobalRole(cfg.role as GlobalRole, targetId);
  } else {
    if (cfg.action === "add") await addChatRole(peerId, cfg.role as ChatRole, targetId);
    else await removeChatRole(peerId, cfg.role as ChatRole, targetId);
  }

  await reply(peerId, cmid, cfg.action === "add" ? "Ранг назначен." : "Ранг снят.");
  return true;
}

// --- Остальные команды (требуют полной настройки чата) ---

async function handleCommand(
  peerId: number,
  fromId: number,
  cmid: number,
  command: string,
  args: string[],
  replyToMessage: ReplyContext | null,
) {
  if (await handleRankCommand(peerId, fromId, cmid, command, args, replyToMessage)) return;

  switch (command) {
    case "/resetdata": {
      if (!isDeveloperId(fromId)) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const keys = await redis.keys("b2:*");
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await reply(peerId, cmid, `Удалено ключей: ${keys.length}`);
      break;
    }

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
        await reply(peerId, cmid, NO_PERMISSION);
        return;
      }
      await reply(peerId, cmid, await buildStaffMessage(peerId));
      break;
    }

    // --- Экономика ---

    case "/reward": {
      const result = await tryClaimReward(fromId);
      if (result.ok) {
        await reply(peerId, cmid, `Вы получили ${result.amount} монет!`);
      } else {
        const minutesLeft = Math.ceil(result.msLeft / 60000);
        await reply(peerId, cmid, `Следующая награда будет доступна через ${minutesLeft} мин.`);
      }
      break;
    }

    case "/balance": {
      const balance = await getBalance(fromId);
      await reply(peerId, cmid, `Ваш баланс: ${balance} монет.`);
      break;
    }

    case "/stats": {
      const { targetId } = await extractTarget(args, replyToMessage);
      const statsUserId = targetId ?? fromId;
      const [role, stats, balance, nick, name] = await Promise.all([
        resolveUserRole(peerId, statsUserId),
        getMessageStats(peerId, statsUserId),
        getBalance(statsUserId),
        getNickFor(peerId, statsUserId),
        nameLinkOf(statsUserId),
      ]);
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
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      const amount = Number(rest[0]);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!amount || amount <= 0) { await reply(peerId, cmid, "Укажите количество монет."); return; }
      const ok = await transferBalance(fromId, targetId, amount);
      await reply(peerId, cmid, ok ? `Вы передали ${amount} монет.` : "Недостаточно монет на балансе.");
      break;
    }

    case "/top": {
      const entries = await getChatTop(peerId);
      await reply(peerId, cmid, `Топ по балансу в чате:\n${await formatTopList(entries)}`);
      break;
    }

    case "/gtop": {
      const entries = await getGlobalTop();
      await reply(peerId, cmid, `Топ по балансу среди всех пользователей:\n${await formatTopList(entries)}`);
      break;
    }

    // --- Баны и кики ---

    case "/ban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      const record: BanRecord = { reason, byUserId: fromId, at: Date.now() };
      await setChatBan(peerId, targetId, record);
      await logBanEvent(targetId, { type: "ban", peerId, ...record });
      await kickFromChat(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из этой беседы пользователя ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/unban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ") || "Не указана";
      await clearChatBan(peerId, targetId);
      await logBanEvent(targetId, { type: "unban", peerId, reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `Бан снят с ${await nameLinkOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/sban": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      const record: BanRecord = { reason, byUserId: fromId, at: Date.now() };
      await setSeniorBan(fromId, targetId, record);
      await logBanEvent(targetId, { type: "sban", ...record });
      await kickFromOwnerGroups(fromId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из ваших бесед пользователя ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/sunban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ") || "Не указана";
      await clearSeniorBan(fromId, targetId);
      await logBanEvent(targetId, { type: "sunban", reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `Бан во всех ваших беседах снят с ${await nameLinkOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/gban": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      const record: BanRecord = { reason, byUserId: fromId, at: Date.now() };
      await setGlobalBan(targetId, record);
      await logBanEvent(targetId, { type: "gban", ...record });
      await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из всех бесед бота пользователя ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/gunban": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ") || "Не указана";
      await clearGlobalBan(targetId);
      await logBanEvent(targetId, { type: "gunban", reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `Глобальный бан снят с ${await nameLinkOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/getban": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      const userId = targetId ?? fromId;

      const [globalBan, seniorBans, chatBan] = await Promise.all([
        getGlobalBan(userId),
        getAllSeniorBans(userId),
        getChatBan(peerId, userId),
      ]);

      const lines = [`Информация о блокировках пользователя ${await nameLinkOf(userId)}`, ""];

      lines.push(`Глобальная блокировка — ${globalBan ? "Да" : "Нет"}`);
      if (globalBan) lines.push(`1) ${formatBanEntry(globalBan, await nameLinkOf(globalBan.byUserId))}`);
      lines.push("");

      lines.push(`Блокировки в ваших беседах — ${seniorBans.length ? "" : "отсутствуют"}`);
      for (let i = 0; i < seniorBans.length; i++) {
        lines.push(`${i + 1}) ${formatBanEntry(seniorBans[i].record, await nameLinkOf(seniorBans[i].record.byUserId))}`);
      }
      lines.push("");

      lines.push(`Блокировка в этой беседе — ${chatBan ? "" : "отсутствует"}`);
      if (chatBan) lines.push(`1) ${formatBanEntry(chatBan, await nameLinkOf(chatBan.byUserId))}`);

      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/banlist": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      const userId = targetId ?? fromId;
      const history = await getBanHistory(userId);
      if (history.length === 0) {
        await reply(peerId, cmid, `У ${await nameLinkOf(userId)} нет истории блокировок.`);
        return;
      }
      const lines = [`История блокировок ${await nameLinkOf(userId)}:`];
      for (const h of history.slice(-15)) {
        lines.push(`${h.type} | ${formatMsk(h.at)} | от ${await nameLinkOf(h.byUserId)} | ${h.reason}`);
      }
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/kick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      await logBanEvent(targetId, { type: "kick", peerId, reason, byUserId: fromId, at: Date.now() });
      await kickFromChat(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из этой беседы пользователя ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/skick": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      await logBanEvent(targetId, { type: "skick", reason, byUserId: fromId, at: Date.now() });
      await kickFromOwnerGroups(fromId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из ваших бесед пользователя ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/gkick": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ") || "Не указана";
      await logBanEvent(targetId, { type: "gkick", reason, byUserId: fromId, at: Date.now() });
      await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из всех бесед бота пользователя ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    // --- Мут / тайм-аут / очистка ---

    case "/mute": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const minutes = Number(rest[0]);
      const reason = rest.slice(1).join(" ") || "Не указана";
      if (!minutes) { await reply(peerId, cmid, "Укажите время мута в минутах."); return; }
      await setMute(peerId, targetId, minutes);
      await reply(peerId, cmid, `${await nameLinkOf(targetId)} замучен на ${minutes} мин. Причина: ${reason}`);
      break;
    }

    case "/unmute": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ") || "Не указана";
      await clearMute(peerId, targetId);
      await reply(peerId, cmid, `Мут снят с ${await nameLinkOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/timeout": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const active = await isTimeoutActive(peerId);
      if (active) {
        await setTimeoutMode(peerId, false);
        await reply(peerId, cmid, "Режим тишины выключен.");
      } else {
        await setTimeoutMode(peerId, true);
        const keyboard = JSON.stringify({
          inline: true,
          buttons: [[
            {
              action: { type: "callback", label: "Выключить", payload: JSON.stringify({ action: "timeout_off" }) },
              color: "negative",
            },
          ]],
        });
        await sendMessageAndGetIds(peerId, "Режим тишины включён.", { keyboard, replyToConversationMessageId: cmid });
      }
      break;
    }

    case "/clear": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      if (!replyToMessage) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, replyToMessage.fromId))) {
        await reply(peerId, cmid, "Вы не можете очистить сообщения данного пользователя!");
        return;
      }
      await callVkApi("messages.delete", {
        peer_id: String(peerId),
        cmids: String(replyToMessage.conversationMessageId),
        delete_for_all: "1",
      });
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} очистил-(а) сообщение-(я)!`);
      break;
    }

    // --- Ники ---

    case "/setnick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const nick = rest.join(" ");
      if (!nick) { await reply(peerId, cmid, "Укажите ник."); return; }
      await setNickFor(peerId, targetId, nick);
      await reply(peerId, cmid, `Ник для ${await nameLinkOf(targetId)} установлен: ${nick}`);
      break;
    }

    case "/removenick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      await removeNickFor(peerId, targetId);
      await reply(peerId, cmid, `Ник для ${await nameLinkOf(targetId)} убран.`);
      break;
    }

    case "/getnick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const nick = await getNickFor(peerId, targetId);
      await reply(peerId, cmid, nick ? `Ник: ${nick}` : "У пользователя нет ника.");
      break;
    }

    case "/getacc": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const nick = args.join(" ");
      if (!nick) { await reply(peerId, cmid, "Укажите ник."); return; }
      const userId = await findUserIdByNick(peerId, nick);
      await reply(peerId, cmid, userId ? `Профиль: ${await nameLinkOf(userId)}` : "Ник не найден.");
      break;
    }

    case "/nlist": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const nicks = await listNicks(peerId);
      if (nicks.length === 0) { await reply(peerId, cmid, "В чате нет ников."); return; }
      const lines = ["Пользователи с ником:"];
      let i = 1;
      for (const n of nicks) lines.push(`${i++}) ${await nameLinkOf(n.userId)} — ${n.nick}`);
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
    return;
  }

  if (payload.action === "timeout_off") {
    if (!(await hasAtLeastRole(peerId, userId, "admin"))) return;
    await setTimeoutMode(peerId, false);
    await callVkApi("messages.edit", {
      peer_id: String(peerId),
      conversation_message_id: String(obj.conversation_message_id),
      message: `${await nameLinkOf(userId)} выключил режим тишины!`,
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

  // Активная блокировка (chat/senior/global) — сразу кикаем, даже если уже в чате.
  const activeBan = await getActiveBanForChat(peerId, fromId);
  if (activeBan) {
    await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
    await kickFromChat(peerId, fromId);
    await sendMessageAndGetIds(
      peerId,
      `${await nameLinkOf(fromId)} исключён-(а) — данный пользователь находится в блокировке.`,
    );
    return;
  }

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

  const replyToMessage: ReplyContext | null = message.reply_message
    ? { fromId: message.reply_message.from_id, conversationMessageId: message.reply_message.conversation_message_id }
    : null;

  // Символы вызова команды: / + !
  if (text.length > 1 && ["/", "+", "!"].includes(text[0])) {
    let [command, ...args] = text.split(/\s+/);
    command = "/" + command.slice(1).toLowerCase();

    const altTarget = ALT_MAP[command.slice(1)];
    if (altTarget) command = altTarget;

    const handledAsSetup = await handleSetupCommand(peerId, fromId, cmid, command, args);
    if (handledAsSetup) return;

    if (!isDeveloperId(fromId) && !(await isChatConfigured(peerId)) && command !== "/help") {
      await reply(peerId, cmid, await getConfigStatusMessage(peerId));
      return;
    }

    await handleCommand(peerId, fromId, cmid, command, args, replyToMessage);
    return;
  }

  // Обычное (не команда) сообщение — считаем для экономики и антифлуда, если чат настроен.
  if (await isChatConfigured(peerId)) {
    await trackMessage(peerId, fromId);

    const shouldKick = await trackFloodAndShouldKick(peerId, fromId, text);
    if (shouldKick) {
      await kickFromChat(peerId, fromId);
      await sendMessageAndGetIds(peerId, `${await nameLinkOf(fromId)} исключён-(а) за флуд.`);
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
      const obj = body.object;
      const peerId = obj.chat_id ? obj.chat_id + 2_000_000_000 : obj.peer_id;
      const userId = obj.user_id;
      if (peerId && userId) {
        const ban = await getActiveBanForChat(peerId, userId);
        if (ban) {
          await kickFromChat(peerId, userId);
        }
      }
    }
  } catch (e) {
    console.error("Ошибка обработки события:", e);
  }

  return new Response("ok", { status: 200 });
});
