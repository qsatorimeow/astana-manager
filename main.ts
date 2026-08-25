// Бот 2 (astana-manager) — Deno Deploy + Upstash Redis
// ------------------------------------------------------
// Переменные окружения:
//   VK_TOKEN, VK_CONFIRMATION, VK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   DEVELOPER_IDS — VK ID разработчика(ов) через запятую; разработчик обходит все проверки
//   (кроме одной: разработчик тоже не может действовать сам на себя)
//
// Бот работает ТОЛЬКО в беседах (не в ЛС), кроме /resetdata — она доступна
// разработчику ТОЛЬКО в личных сообщениях боту.
//
// Полная цепочка настройки беседы: /sync → /server → /addgroup → /type.
// Пока не выполнен /sync — бот вообще ничего не пишет и не реагирует
// (кроме разработчика). После /sync — подсказывает, что осталось настроить.
//
// Иерархия банов: /ban — только этот чат; /sban — все чаты СЕРВЕРА, к которому
// привязан этот чат (см. /server); /gban — вообще везде.
//
// Символы вызова команды: / + !
// Назначение ранга можно коротко: /moder, /senmoder, /admin, /senadmin, /zsa, /sa
// (снятие — всегда полной формой: /delmoder и т.д.)

import { redis } from "./kv.ts";
import {
  callVkApi,
  getBotGroupId,
  getConversationMembers,
  getOnlineMembers,
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
  CHAT_ROLES,
  type ChatRole,
  getUserChatRole,
  getUserGlobalRole,
  type GlobalRole,
  hasAtLeastRole,
  isDeveloperId,
  removeChatRole,
  removeGlobalRole,
  resolveUserRole,
  ROLE_GENITIVE,
  ROLE_LABEL,
} from "./roles.ts";
import {
  addGroup,
  buildSyncListMessage,
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
  addServer,
  bindChatToServer,
  buildServersListMessage,
  getChatServer,
  removeServer,
  serverExists,
} from "./servers.ts";
import { clearActivity, getMessageStats, trackMessage } from "./activity.ts";
import {
  type BanRecord,
  clearChatBan,
  clearGlobalBan,
  clearMute,
  clearServerBan,
  getActiveBanForChat,
  getAllServerBans,
  getBanHistory,
  getChatBan,
  getGlobalBan,
  isMuted,
  isTimeoutActive,
  kickFromAllSyncedChats,
  kickFromServerChats,
  logBanEvent,
  setChatBan,
  setGlobalBan,
  setMute,
  setServerBan,
  setTimeoutMode,
  trackFloodAndShouldKick,
} from "./moderation.ts";
import { findUserIdByNick, getNickFor, listNicks, removeNickFor, setNickFor } from "./nicknames.ts";
import { ALT_MAP, buildHelpMessage, buildStaffMessage } from "./staff.ts";

const VK_CONFIRMATION = Deno.env.get("VK_CONFIRMATION") ?? "";
const VK_SECRET = Deno.env.get("VK_SECRET") ?? "";
const NO_PERMISSION = "Недостаточно прав!";
const NO_TARGET = "Вы не указали пользователя";
const NO_REASON = "Вы не указали причину";

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

/** Никто не может действовать на себя (даже разработчик). Иначе — строго выше рангом. */
async function canActOn(peerId: number, actorId: number, targetId: number): Promise<boolean> {
  if (actorId === targetId) return false;
  if (isDeveloperId(actorId)) return true;
  const [actor, target] = await Promise.all([
    resolveUserRole(peerId, actorId),
    resolveUserRole(peerId, targetId),
  ]);
  return actor.weight > target.weight;
}

function formatBanEntry(record: BanRecord, byName: string): string {
  const label = record.chatLabel ? `${record.chatLabel} | ` : "";
  return `${label}${byName} | ${record.reason} | ${formatMsk(record.at)}`;
}

/** При кике пользователь полностью теряет все данные, привязанные к этой беседе. */
async function purgeUserFromChat(peerId: number, userId: number): Promise<void> {
  for (const role of CHAT_ROLES) {
    await removeChatRole(peerId, role, userId);
  }
  await removeNickFor(peerId, userId);
  await clearActivity(peerId, userId);
}

async function kickAndPurge(peerId: number, userId: number): Promise<void> {
  await kickFromChat(peerId, userId);
  await purgeUserFromChat(peerId, userId);
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
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      if (await isSynced(peerId)) { await reply(peerId, cmid, "Эта беседа уже синхронизирована."); return true; }
      await setSync(peerId, fromId);
      await reply(peerId, cmid, "Синхронизация с базой данных прошла успешно!\nТеперь привяжите беседу к серверу: /server название");
      return true;
    }

    case "/delsync": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await clearSync(peerId);
      await reply(peerId, cmid, "Синхронизация с базой данных удалена.");
      return true;
    }

    case "/synclist": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await reply(peerId, cmid, await buildSyncListMessage());
      return true;
    }

    case "/addserver": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const name = args.join(" ");
      if (!name) { await reply(peerId, cmid, "Формат: /addserver название"); return true; }
      const created = await addServer(name);
      await reply(peerId, cmid, created ? `Сервер «${name}» добавлен в список серверов проекта.` : "Сервер с таким названием уже существует.");
      return true;
    }

    case "/delserver": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const name = args.join(" ");
      if (!name) { await reply(peerId, cmid, "Формат: /delserver название"); return true; }
      await removeServer(name);
      await reply(peerId, cmid, `Сервер «${name}» удалён из списка серверов проекта.`);
      return true;
    }

    case "/servers": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await reply(peerId, cmid, await buildServersListMessage());
      return true;
    }

    case "/server": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const name = args.join(" ");
      if (!name) { await reply(peerId, cmid, "Формат: /server название"); return true; }
      if (!(await serverExists(name))) { await reply(peerId, cmid, "Такого сервера не существует. Сначала /addserver."); return true; }
      await bindChatToServer(peerId, name);
      await reply(peerId, cmid, `Вы привязали беседу к серверу: ${name}\nТеперь привяжите чат к себе: /addgroup`);
      return true;
    }

    case "/addgroup": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const targetPeer = args[0] ? Number(args[0]) : peerId;
      if (await isGroupAdded(targetPeer)) { await reply(peerId, cmid, "Эта беседа уже привязана. Сначала нужно её отвязать (/delgroup)."); return true; }
      await addGroup(targetPeer, fromId);
      await reply(peerId, cmid, "Данная беседа добавлена в список ваших чатов.\nТеперь с помощью /type Вы можете выбрать тип беседы!");
      return true;
    }

    case "/delgroup": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const targetPeer = args[0] ? Number(args[0]) : peerId;
      const owner = await getGroupOwner(targetPeer);
      if (owner !== null && owner !== fromId && !isDeveloperId(fromId)) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await removeGroup(targetPeer, owner ?? fromId);
      await reply(peerId, cmid, "Данная беседа удалена из списка ваших чатов.");
      return true;
    }

    case "/mygroups": {
      if (!(await hasAtLeastRole(peerId, fromId, "spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      const groups = await getOwnerGroups(fromId);
      const text = groups.length > 0
        ? ["Список ваших чатов:", ...groups.map((g) => `Чат | ${g}`)].join("\n")
        : "У вас нет привязанных чатов.";
      await reply(peerId, cmid, text);
      return true;
    }

    case "/type": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return true; }
      await setChatType(peerId, "admin");
      await reply(peerId, cmid, 'Вы установили тип беседы "Административный чат"');
      return true;
    }

    default:
      return false;
  }
}

// --- Таблица команд назначения рангов (с короткими алиасами на добавление) ---

interface RankCommandConfig {
  requiredRole: AnyRole;
  action: "add" | "remove";
  role: GlobalRole | ChatRole;
  scope: "global" | "chat";
}

const RANK_BASE: Record<string, Omit<RankCommandConfig, "action">> = {
  sa: { requiredRole: "developer", role: "spec_admin", scope: "global" },
  zsa: { requiredRole: "spec_admin", role: "deputy_spec_admin", scope: "global" },
  senadmin: { requiredRole: "deputy_spec_admin", role: "senior_admin", scope: "chat" },
  admin: { requiredRole: "senior_admin", role: "admin", scope: "chat" },
  senmoder: { requiredRole: "admin", role: "senior_moderator", scope: "chat" },
  moder: { requiredRole: "senior_moderator", role: "moderator", scope: "chat" },
};

const RANK_COMMANDS: Record<string, RankCommandConfig> = {};
for (const [short, cfg] of Object.entries(RANK_BASE)) {
  RANK_COMMANDS[`/${short}`] = { ...cfg, action: "add" }; // короткий алиас — только на назначение
  RANK_COMMANDS[`/add${short}`] = { ...cfg, action: "add" };
  RANK_COMMANDS[`/del${short}`] = { ...cfg, action: "remove" };
}

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

  if (!(await hasAtLeastRole(peerId, fromId, cfg.requiredRole))) { await reply(peerId, cmid, NO_PERMISSION); return true; }

  const { targetId } = await extractTarget(args, replyToMessage);
  if (!targetId) { await reply(peerId, cmid, NO_TARGET); return true; }
  if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return true; }

  if (cfg.scope === "global") {
    if (cfg.action === "add") {
      // Один пользователь — одна должность: снимаем прежнюю глобальную роль перед назначением новой.
      const current = await getUserGlobalRole(targetId);
      if (current && current !== cfg.role) await removeGlobalRole(current, targetId);
      await addGlobalRole(cfg.role as GlobalRole, targetId);
    } else {
      await removeGlobalRole(cfg.role as GlobalRole, targetId);
    }
  } else {
    if (cfg.action === "add") {
      const current = await getUserChatRole(peerId, targetId);
      if (current && current !== cfg.role) await removeChatRole(peerId, current, targetId);
      await addChatRole(peerId, cfg.role as ChatRole, targetId);
    } else {
      await removeChatRole(peerId, cfg.role as ChatRole, targetId);
    }
  }

  const genitive = ROLE_GENITIVE[cfg.role];
  const actorName = await nameLinkOf(fromId);
  const targetName = await nameLinkOf(targetId);
  const text = cfg.action === "add"
    ? `${actorName} выдал-(а) права ${genitive} ${targetName}`
    : `${actorName} забрал-(а) права ${genitive} у ${targetName}`;
  await reply(peerId, cmid, text);
  return true;
}

// --- Определение "стаффа" чата (для /zov — не тегаем стафф) ---

async function isChatStaff(peerId: number, userId: number): Promise<boolean> {
  const { weight } = await resolveUserRole(peerId, userId);
  return weight >= 40; // moderator и выше
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
          "/timeout — тишина",
          "/onlinelist — olist, онлайн",
        ].join("\n"),
      );
      break;
    }

    case "/staff": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      await reply(peerId, cmid, await buildStaffMessage(peerId));
      break;
    }

    case "/stats": {
      const { targetId } = await extractTarget(args, replyToMessage);
      const statsUserId = targetId ?? fromId;
      const [role, stats, nick, name] = await Promise.all([
        resolveUserRole(peerId, statsUserId),
        getMessageStats(peerId, statsUserId),
        getNickFor(peerId, statsUserId),
        nameLinkOf(statsUserId),
      ]);
      const lines = [
        `Информация о пользователе ${name}`,
        `Роль: ${ROLE_LABEL[role.role]}`,
        `Ник: ${nick ?? "Нет"}`,
        `Всего сообщений: ${stats.count}`,
        `Последнее сообщение: ${stats.lastMessageMs ? formatMsk(stats.lastMessageMs) : "нет данных"}`,
      ];
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/onlinelist": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const online = (await getOnlineMembers(peerId)).filter((u) => u.id !== fromId);
      const callerName = await nameLinkOf(fromId);
      if (online.length === 0) {
        await reply(peerId, cmid, `${callerName}, сейчас никого нет онлайн.`);
        return;
      }
      const lines = [`${callerName}, список пользователей онлайн`];
      for (const u of online) lines.push(`[id${u.id}|${u.first_name} ${u.last_name}] — 💻`);
      lines.push(`Всего в онлайн: ${online.length}`);
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    case "/zov": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = args.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const members = await getConversationMembers(peerId);
      const targets: number[] = [];
      for (const m of members) {
        if (m.memberId <= 0) continue;
        if (await isChatStaff(peerId, m.memberId)) continue;
        targets.push(m.memberId);
      }
      const hearts = targets.map((id) => `[id${id}|🖤]`).join("");
      const text = [
        "🔔 Вы были вызваны администратором беседы",
        "",
        hearts,
        "",
        `❗ Причина вызова: ${reason}`,
      ].join("\n");
      await sendMessageAndGetIds(peerId, text);
      break;
    }

    // --- Баны ---

    case "/ban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const record: BanRecord = { reason, byUserId: fromId, at: Date.now() };
      await setChatBan(peerId, targetId, record);
      await logBanEvent(targetId, { type: "ban", peerId, ...record });
      await kickAndPurge(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} заблокировал-(а) в этой беседе ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
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
      const serverName = await getChatServer(peerId);
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const record: BanRecord = { reason, byUserId: fromId, at: Date.now(), chatLabel: serverName };
      await setServerBan(serverName, targetId, record);
      await logBanEvent(targetId, { type: "sban", ...record });
      await kickFromServerChats(serverName, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} заблокировал-(а) во всех беседах сервера ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/sunban": {
      if (!(await hasAtLeastRole(peerId, fromId, "senior_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const serverName = await getChatServer(peerId);
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      const reason = rest.join(" ") || "Не указана";
      await clearServerBan(serverName, targetId);
      await logBanEvent(targetId, { type: "sunban", reason, byUserId: fromId, at: Date.now() });
      await reply(peerId, cmid, `Бан во всех беседах сервера снят с ${await nameLinkOf(targetId)}. Причина: ${reason}`);
      break;
    }

    case "/gban": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      const record: BanRecord = { reason, byUserId: fromId, at: Date.now() };
      await setGlobalBan(targetId, record);
      await logBanEvent(targetId, { type: "gban", ...record });
      await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} заблокировал-(а) во всех серверах ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
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

      const [globalBan, serverBans, chatBan] = await Promise.all([
        getGlobalBan(userId),
        getAllServerBans(userId),
        getChatBan(peerId, userId),
      ]);

      const lines = [`Информация о блокировках пользователя ${await nameLinkOf(userId)}`, ""];

      lines.push(`Глобальная блокировка — ${globalBan ? "Да" : "Нет"}`);
      if (globalBan) lines.push(`1) ${formatBanEntry(globalBan, await nameLinkOf(globalBan.byUserId))}`);
      lines.push("");

      lines.push(`Блокировки в ваших беседах — ${serverBans.length ? "" : "отсутствуют"}`);
      for (let i = 0; i < serverBans.length; i++) {
        lines.push(`${i + 1}) ${formatBanEntry(serverBans[i].record, await nameLinkOf(serverBans[i].record.byUserId))}`);
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
      if (history.length === 0) { await reply(peerId, cmid, `У ${await nameLinkOf(userId)} нет истории блокировок.`); return; }
      const lines = [`История блокировок ${await nameLinkOf(userId)}:`];
      for (const h of history.slice(-15)) {
        lines.push(`${h.type} | ${formatMsk(h.at)} | от ${await nameLinkOf(h.byUserId)} | ${h.reason}`);
      }
      await reply(peerId, cmid, lines.join("\n"));
      break;
    }

    // --- Кики ---

    case "/kick": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      await logBanEvent(targetId, { type: "kick", peerId, reason: "Не указана", byUserId: fromId, at: Date.now() });
      await kickAndPurge(peerId, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из этой беседы ${await nameLinkOf(targetId)}`);
      break;
    }

    case "/skick": {
      if (!(await hasAtLeastRole(peerId, fromId, "admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const serverName = await getChatServer(peerId);
      if (!serverName) { await reply(peerId, cmid, "Эта беседа не привязана к серверу."); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      await logBanEvent(targetId, { type: "skick", reason, byUserId: fromId, at: Date.now() });
      await kickFromServerChats(serverName, targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из всех бесед сервера ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
      break;
    }

    case "/gkick": {
      if (!(await hasAtLeastRole(peerId, fromId, "deputy_spec_admin"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const { targetId, rest } = await extractTarget(args, replyToMessage);
      if (!targetId) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, targetId))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      const reason = rest.join(" ");
      if (!reason) { await reply(peerId, cmid, NO_REASON); return; }
      await logBanEvent(targetId, { type: "gkick", reason, byUserId: fromId, at: Date.now() });
      await kickFromAllSyncedChats(targetId);
      await reply(peerId, cmid, `${await nameLinkOf(fromId)} исключил-(а) из всех серверов ${await nameLinkOf(targetId)}\nПричина: ${reason}`);
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
            { action: { type: "callback", label: "Выключить", payload: JSON.stringify({ action: "timeout_off" }) }, color: "negative" },
          ]],
        });
        await sendMessageAndGetIds(peerId, "Режим тишины включён.", { keyboard, replyToConversationMessageId: cmid });
      }
      break;
    }

    case "/clear": {
      if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) { await reply(peerId, cmid, NO_PERMISSION); return; }
      if (!replyToMessage) { await reply(peerId, cmid, NO_TARGET); return; }
      if (!(await canActOn(peerId, fromId, replyToMessage.fromId)) && replyToMessage.fromId !== fromId) {
        await reply(peerId, cmid, "Вы не можете очистить сообщения данного пользователя!");
        return;
      }
      await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(replyToMessage.conversationMessageId), delete_for_all: "1" });
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
      break;
  }
}

// --- Нажатия кнопок ---

// deno-lint-ignore no-explicit-any
async function handleMessageEvent(body: any) {
  const obj = body.object;
  const peerId = obj.peer_id;
  const userId = obj.user_id;
  if (!isChatPeer(peerId)) return;

  await callVkApi("messages.sendMessageEventAnswer", { event_id: obj.event_id, user_id: String(userId), peer_id: String(peerId) });

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = typeof obj.payload === "string" ? JSON.parse(obj.payload) : obj.payload ?? {};
  } catch {
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
  const fromId = message.from_id;
  const text = (message.text ?? "").trim();

  if (!isChatPeer(peerId)) {
    const normalized = text.replace(/^[+!]/, "/").toLowerCase();
    if (normalized === "/resetdata" && isDeveloperId(fromId)) {
      const keys = await redis.keys("b2:*");
      if (keys.length > 0) await redis.del(...keys);
      await sendMessageAndGetIds(peerId, `Удалено ключей: ${keys.length}`);
    }
    return;
  }

  const cmid = message.conversation_message_id;

  const activeBan = await getActiveBanForChat(peerId, fromId);
  if (activeBan) {
    await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
    await kickAndPurge(peerId, fromId);
    await sendMessageAndGetIds(peerId, `${await nameLinkOf(fromId)} исключён-(а) — данный пользователь находится в блокировке.`);
    return;
  }

  if (await isMuted(peerId, fromId)) {
    await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
    return;
  }

  if (await isTimeoutActive(peerId)) {
    if (!(await hasAtLeastRole(peerId, fromId, "moderator"))) {
      await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
      return;
    }
  }

  const replyToMessage: ReplyContext | null = message.reply_message
    ? { fromId: message.reply_message.from_id, conversationMessageId: message.reply_message.conversation_message_id }
    : null;

  if (text.length > 1 && ["/", "+", "!"].includes(text[0])) {
    let [command, ...args] = text.split(/\s+/);
    command = "/" + command.slice(1).toLowerCase();

    const altTarget = ALT_MAP[command.slice(1)];
    if (altTarget) command = altTarget;

    if (!isDeveloperId(fromId) && !(await isSynced(peerId)) && command !== "/sync") return;

    const handledAsSetup = await handleSetupCommand(peerId, fromId, cmid, command, args);
    if (handledAsSetup) return;

    if (!isDeveloperId(fromId) && !(await isChatConfigured(peerId)) && command !== "/help") {
      await reply(peerId, cmid, await getConfigStatusMessage(peerId));
      return;
    }

    await handleCommand(peerId, fromId, cmid, command, args, replyToMessage);
    return;
  }

  if (await isChatConfigured(peerId)) {
    await trackMessage(peerId, fromId);

    const shouldKick = await trackFloodAndShouldKick(peerId, fromId, text);
    if (shouldKick) {
      await kickAndPurge(peerId, fromId);
      await sendMessageAndGetIds(peerId, `${await nameLinkOf(fromId)} исключён-(а) за флуд.`);
    }
  }
}

// --- Добавление / выход из беседы ---

// deno-lint-ignore no-explicit-any
async function handleChatInviteUser(body: any) {
  const obj = body.object;
  const peerId: number | undefined = obj.chat_id ? obj.chat_id + 2_000_000_000 : obj.peer_id;
  const userId: number | undefined = obj.user_id;
  if (!peerId || !userId) return;

  if (userId < 0) {
    const botGroupId = await getBotGroupId();
    if (botGroupId && -userId === botGroupId) {
      await sendMessageAndGetIds(peerId, "Бот добавлен в беседу, выдайте мне администратора, а затем введите /sync для синхронизации c базой данных!");
    }
    return;
  }

  // Обычный пользователь не может никого добавлять — если так, кикаем добавленного.
  const initiatorId: number | undefined = obj.initiator_id;
  if (initiatorId && initiatorId !== userId && !(await hasAtLeastRole(peerId, initiatorId, "moderator"))) {
    await kickFromChat(peerId, userId);
    return;
  }

  const ban = await getActiveBanForChat(peerId, userId);
  if (ban) {
    await kickFromChat(peerId, userId);
    return;
  }

  if (!(await isChatConfigured(peerId))) return;

  await sendMessageAndGetIds(
    peerId,
    [
      `${await nameLinkOf(userId)}, добро пожаловать в беседу!`,
      "Не забудь прочитать закреплённое сообщение!",
      'Посмотреть ссылки на официальные ресурсы проекта: «/info»',
    ].join("\n"),
  );
}

/** Самостоятельный выход из беседы — очищаем данные пользователя в этом чате. */
// deno-lint-ignore no-explicit-any
async function handleChatKickUser(body: any) {
  const obj = body.object;
  const peerId: number | undefined = obj.chat_id ? obj.chat_id + 2_000_000_000 : obj.peer_id;
  const userId: number | undefined = obj.user_id;
  if (!peerId || !userId) return;
  await purgeUserFromChat(peerId, userId);
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
      await handleChatInviteUser(body);
    } else if (body.type === "chat_kick_user") {
      await handleChatKickUser(body);
    }
  } catch (e) {
    console.error("Ошибка обработки события:", e);
  }

  return new Response("ok", { status: 200 });
});
