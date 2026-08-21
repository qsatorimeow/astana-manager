// Полная логика очереди мероприятий.
// ВАЖНО: очередь ОДНА на каждую беседу, независимо от названия мероприятия.
// waiting = ждёт; active = сейчас проводит; finished/cancelled/timeout = ушёл из очереди.

import { callVkApi, getUsersInfo, mention, sendMessageAndGetIds } from "../vk.ts";
import { formatMsk, parseMskTimeToTimestamp } from "../time.ts";
import { buildEmptyKeyboard, buildEventKeyboard } from "./keyboard.ts";
import {
  clearAwaitingKd,
  clearAwaitingReason,
  clearPendingDelete,
  type EventEntry,
  getAwaitingKd as _getAwaitingKd,
  getAwaitingReason as _getAwaitingReason,
  getChatsWithPending,
  getDueDeletes,
  getEntry,
  getNick,
  getPendingEntryIds,
  getTopUsers,
  getTotalCount,
  incrementStats,
  nextEntryId,
  peekQueueHead,
  popQueueHead,
  pushToQueue,
  rebuildQueue,
  removeFromQueue,
  saveEntry,
  setAwaitingKd as _setAwaitingKd,
  setAwaitingReason as _setAwaitingReason,
} from "./store.ts";

const THIRTY_MIN_MS = 30 * 60 * 1000;
const THREE_MIN_MS = 3 * 60 * 1000;
const AUTO_KD_MS = 10 * 60 * 1000;

function randomId(): string {
  return String(Math.floor(Math.random() * 2_000_000_000) - 1_000_000_000);
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} ч. ${minutes} мин. ${seconds} сек.`;
  return `${minutes} мин. ${seconds} сек.`;
}

function buildDeadlineText(deadline: number): string {
  return `Осталось: ${formatRemaining(deadline - Date.now())}.\nКрайний срок: ${formatMsk(deadline)}.`;
}

async function sendChatMessage(peerId: number, text: string, keyboard?: string) {
  return await sendMessageAndGetIds(peerId, text, keyboard);
}

async function sendDirectMessage(userId: number, text: string) {
  return await callVkApi("messages.send", {
    user_id: String(userId),
    message: text,
    random_id: randomId(),
  });
}

async function editEntryMessage(entry: EventEntry, text: string, keyboard?: string): Promise<boolean> {
  const params: Record<string, string> = {
    peer_id: String(entry.peerId),
    message: text,
    random_id: "0",
  };

  if (entry.conversationMessageId && entry.conversationMessageId > 0) {
    params.conversation_message_id = String(entry.conversationMessageId);
  } else if (entry.messageId && entry.messageId > 0) {
    params.message_id = String(entry.messageId);
  } else {
    console.error(`[DEBUG] editEntryMessage: у записи #${entry.id} нет ID сообщения`);
    return false;
  }

  if (keyboard !== undefined) params.keyboard = keyboard;

  const result = await callVkApi("messages.edit", params);
  if (result?.error) {
    console.error(`[VK] Ошибка messages.edit для #${entry.id}:`, JSON.stringify(result.error));
    return false;
  }
  return true;
}

async function getDisplayName(peerId: number, userId: number): Promise<string> {
  const nick = await getNick(peerId, userId);
  if (nick) return `[id${userId}|${nick}]`;
  const infoMap = await getUsersInfo([userId]);
  return mention(userId, infoMap.get(userId));
}

// ----------------------------------------------------
// ЗАНЯТИЕ
// ----------------------------------------------------

export async function joinEvent(peerId: number, userId: number, eventName: string): Promise<string> {
  const pendingIds = await getPendingEntryIds(peerId);

  for (const pendingId of pendingIds) {
    const existing = await getEntry(peerId, pendingId);
    if (existing && existing.ownerId === userId && (existing.status === "waiting" || existing.status === "active")) {
      return `⚠️ Сначала завершите (КД/откат) текущее мероприятие «${existing.eventName}» (#${existing.id}), прежде чем занимать новое.`;
    }
  }

  // Мигрируем старые записи в одну общую очередь. Это важно для уже существующего Redis.
  await rebuildQueue(peerId);

  const id = await nextEntryId(peerId);
  const ownerName = await getDisplayName(peerId, userId);
  const entry: EventEntry = {
    id,
    peerId,
    eventName,
    ownerId: userId,
    ownerName,
    status: "waiting",
    createdAt: Date.now(),
  };

  await saveEntry(entry);
  await pushToQueue(peerId, eventName, id);

  const head = await peekQueueHead(peerId);
  if (head === id) {
    await activateEntry(peerId, id);
    return "";
  }

  // Для waiting вообще ничего не отправляем.
  // Главное сообщение появится только тогда, когда очередь реально дойдет до этого игрока.
  return "";
}

// ----------------------------------------------------
// АКТИВАЦИЯ
// ----------------------------------------------------

async function activateEntry(peerId: number, id: number): Promise<boolean> {
  const entry = await getEntry(peerId, id);
  if (!entry) return false;

  const head = await peekQueueHead(peerId);
  if (head !== id) {
    console.log(`[DEBUG] #${id} не активирован: голова общей очереди #${head ?? "нет"}`);
    return false;
  }

  if (entry.status === "active") return true;
  if (entry.status !== "waiting") return false;

  // Дополнительная защита: в чате не может быть двух active одновременно.
  const pendingIds = await getPendingEntryIds(peerId);
  for (const otherId of pendingIds) {
    if (otherId === id) continue;
    const other = await getEntry(peerId, otherId);
    if (other?.status === "active") {
      console.log(`[DEBUG] #${id} не активирован: уже активно #${other.id}`);
      return false;
    }
  }

  entry.status = "active";
  entry.activatedAt = Date.now();
  entry.lastReminderAt = entry.activatedAt;
  entry.scheduledAt = undefined;
  entry.readyNotifiedAt = undefined;
  entry.kdAt = undefined;
  entry.kdDisplay = undefined;
  await saveEntry(entry);

  const text = [
    `📌 ${entry.ownerName} занял мероприятие`,
    `Название: "${entry.eventName}"`,
    `Кд: не указан`,
    `⏱️ На проведение: 30 минут`,
  ].join("\n");

  const ids = await sendChatMessage(peerId, text, buildEventKeyboard(entry.id));
  if (ids.messageId || ids.conversationMessageId) {
    entry.messageId = ids.messageId;
    entry.conversationMessageId = ids.conversationMessageId;
    await saveEntry(entry);
    console.log(`[DEBUG] #${entry.id}: messageId=${entry.messageId ?? "нет"}, conversationMessageId=${entry.conversationMessageId ?? "нет"}`);
  } else {
    console.error(`[ERROR] Не удалось получить ID сообщения для #${entry.id}`);
  }

  const deadline = entry.activatedAt + THIRTY_MIN_MS;
  const dm = await sendDirectMessage(
    entry.ownerId,
    `🔔 Настала ваша очередь провести мероприятие «${entry.eventName}» (#${entry.id}).\n${buildDeadlineText(deadline)}`,
  );
  if (dm?.error) {
    console.error(`[VK] Не удалось отправить ЛС пользователю ${entry.ownerId}:`, JSON.stringify(dm.error));
  }

  return true;
}

async function promoteToActive(peerId: number): Promise<void> {
  const nextId = await peekQueueHead(peerId);
  if (!nextId) return;
  const next = await getEntry(peerId, nextId);
  if (!next || next.status !== "waiting") return;

  if (next.scheduledAt && next.scheduledAt > Date.now()) return;
  await activateEntry(peerId, nextId);
}

async function notifyNextGettingReady(peerId: number, activateAt: number): Promise<void> {
  const nextId = await peekQueueHead(peerId);
  if (!nextId) return;

  const next = await getEntry(peerId, nextId);
  if (!next || next.status !== "waiting") return;

  next.scheduledAt = activateAt;
  next.readyNotifiedAt = Date.now();
  await saveEntry(next);

  const dm = await sendDirectMessage(
    next.ownerId,
    `⏳ Готовьтесь: скоро ваша очередь провести мероприятие «${next.eventName}» (#${next.id}).\n` +
      `До вашей очереди: ${formatRemaining(activateAt - Date.now())}.\n` +
      `Крайний срок: ${formatMsk(activateAt)}.`,
  );
  if (dm?.error) {
    console.error(`[VK] Не удалось отправить ЛС пользователю ${next.ownerId}:`, JSON.stringify(dm.error));
  }
}

// ----------------------------------------------------
// ЗАВЕРШЕНИЕ ПО КД
// ----------------------------------------------------

async function finishActiveEntry(entry: EventEntry, kdAt: number, kdDisplay: string): Promise<void> {
  if (entry.status !== "active") return;

  entry.status = "finished";
  entry.kdAt = kdAt;
  entry.kdDisplay = kdDisplay;
  await saveEntry(entry);
  await incrementStats(entry.peerId, entry.ownerId);

  // Только фактическое время КД. Никаких «(+10 мин)».
  await editEntryMessage(
    entry,
    [
      `✅ ${entry.ownerName} закончил мероприятие`,
      `Название: "${entry.eventName}"`,
      `Кд: ${kdDisplay}`,
    ].join("\n"),
    buildEmptyKeyboard(),
  );

  await popQueueHead(entry.peerId);
  await notifyNextGettingReady(entry.peerId, kdAt);
}

export async function handleKdButton(peerId: number, userId: number, entryId: number): Promise<void> {
  const entry = await getEntry(peerId, entryId);
  if (!entry || entry.status !== "active" || entry.ownerId !== userId) return;

  const kdAt = Date.now() + AUTO_KD_MS;
  await finishActiveEntry(entry, kdAt, formatMsk(kdAt));
}

// ----------------------------------------------------
// НАПИСАТЬ КД
// ----------------------------------------------------

export async function handleKdPromptButton(peerId: number, userId: number, entryId: number): Promise<void> {
  const entry = await getEntry(peerId, entryId);
  if (!entry || entry.status !== "active" || entry.ownerId !== userId) return;

  await editEntryMessage(entry, "✏️ Напишите КД мероприятия:", buildEmptyKeyboard());
  await _setAwaitingKd(peerId, userId, entryId);
}

export async function getAwaitingKdEntryId(peerId: number, userId: number): Promise<number | null> {
  return await _getAwaitingKd(peerId, userId);
}

export async function applyCustomKd(peerId: number, userId: number, entryId: number, timeText: string): Promise<string> {
  const entry = await getEntry(peerId, entryId);
  if (!entry || entry.status !== "active" || entry.ownerId !== userId) {
    await clearAwaitingKd(peerId, userId);
    return "";
  }

  const kdAt = parseMskTimeToTimestamp(timeText);
  if (kdAt === null) return "⚠️ Неверный формат времени. Укажите КД в формате чч:мм, например 21:30.";

  await clearAwaitingKd(peerId, userId);
  await finishActiveEntry(entry, kdAt, timeText.trim());
  return "";
}

// ----------------------------------------------------
// ОТКАТ
// ----------------------------------------------------

export async function handleRollbackButton(peerId: number, userId: number, entryId: number): Promise<void> {
  const entry = await getEntry(peerId, entryId);
  if (!entry || entry.status !== "active" || entry.ownerId !== userId) return;

  const now = Date.now();
  entry.status = "cancelled";
  entry.kdAt = now;
  entry.scheduledAt = undefined;
  entry.readyNotifiedAt = undefined;
  await saveEntry(entry);

  await editEntryMessage(
    entry,
    [
      `↩️ ${entry.ownerName} откатил своё мероприятие`,
      `Название: "${entry.eventName}"`,
      `Время отката: ${formatMsk(now)}`,
    ].join("\n"),
    buildEmptyKeyboard(),
  );

  await popQueueHead(entry.peerId);
  await promoteToActive(entry.peerId);
}

// ----------------------------------------------------
// АННУЛИРОВАНИЕ
// ----------------------------------------------------

export async function handleCancelButton(peerId: number, userId: number, entryId: number, canModerate: boolean): Promise<void> {
  if (!canModerate) return;
  const entry = await getEntry(peerId, entryId);
  if (!entry || (entry.status !== "active" && entry.status !== "waiting")) return;

  await editEntryMessage(entry, "🚫 Введите причину аннулирования:", buildEmptyKeyboard());
  entry.cancelReasonRequestedBy = userId;
  entry.cancelReasonDeadline = Date.now() + 60_000;
  await saveEntry(entry);
  await _setAwaitingReason(peerId, userId, entryId);
}

export async function getAwaitingReasonEntryId(peerId: number, userId: number): Promise<number | null> {
  return await _getAwaitingReason(peerId, userId);
}

export async function applyCancelReason(peerId: number, moderatorId: number, entryId: number, reason: string): Promise<void> {
  const entry = await getEntry(peerId, entryId);
  await clearAwaitingReason(peerId, moderatorId);
  if (!entry || (entry.status !== "active" && entry.status !== "waiting")) return;
  entry.cancelReasonRequestedBy = undefined;
  entry.cancelReasonDeadline = undefined;

  const wasActive = entry.status === "active";
  entry.status = "cancelled";
  entry.scheduledAt = undefined;
  entry.readyNotifiedAt = undefined;
  await saveEntry(entry);

  await editEntryMessage(
    entry,
    [
      `🚫 Мероприятие ${entry.ownerName} аннулировано`,
      `Название: "${entry.eventName}"`,
      `Причина: ${reason}`,
    ].join("\n"),
    buildEmptyKeyboard(),
  );

  await removeFromQueue(peerId, entry.eventName, entryId);
  if (wasActive) await promoteToActive(peerId);
}

// ----------------------------------------------------
// /delmp
// ----------------------------------------------------

export async function cancelAllOwn(peerId: number, userId: number): Promise<string> {
  const pendingIds = await getPendingEntryIds(peerId);
  let count = 0;

  for (const id of pendingIds) {
    const entry = await getEntry(peerId, id);
    if (!entry || entry.ownerId !== userId) continue;
    if (entry.status !== "waiting" && entry.status !== "active") continue;

    const wasActive = entry.status === "active";
    entry.status = "cancelled";
    entry.scheduledAt = undefined;
    entry.readyNotifiedAt = undefined;
    await saveEntry(entry);

    if (wasActive) {
      await editEntryMessage(
        entry,
        [
          `↩️ ${entry.ownerName} отменил своё мероприятие`,
          `Название: "${entry.eventName}"`,
          `Причина: отменено командой /delmp`,
        ].join("\n"),
        buildEmptyKeyboard(),
      );
    }

    await removeFromQueue(peerId, entry.eventName, id);
    count++;
    if (wasActive) await promoteToActive(peerId);
  }

  return count > 0 ? `↩️ Аннулировано незавершённых мероприятий: ${count}.` : "У вас нет незавершённых мероприятий.";
}

// ----------------------------------------------------
// /top
// ----------------------------------------------------

export async function buildTopMessage(peerId: number): Promise<string> {
  const [top, total] = await Promise.all([getTopUsers(peerId, 10), getTotalCount(peerId)]);
  const lines: string[] = ["🏆 ТОП 10 активных администраторов по Мероприятиям", ""];

  if (top.length === 0) {
    lines.push("Пока никто не завершил ни одного мероприятия.");
  } else {
    const medals = ["🥇", "🥈", "🥉"];
    for (let i = 0; i < top.length; i++) {
      const name = await getDisplayName(peerId, top[i].userId);
      lines.push(`${medals[i] ?? "🎖"} ${name} МП: ${top[i].count}`);
    }
  }

  lines.push("");
  lines.push(`Всего мероприятий на сервере: ${total}`);
  return lines.join("\n");
}

// ----------------------------------------------------
// 30 МИНУТ БЕЗДЕЙСТВИЯ
// ----------------------------------------------------

async function timeoutEntry(entry: EventEntry): Promise<void> {
  if (entry.status !== "active") return;

  entry.status = "timeout";
  entry.scheduledAt = undefined;
  entry.readyNotifiedAt = undefined;
  await saveEntry(entry);

  await editEntryMessage(
    entry,
    [
      `Мероприятие ${entry.ownerName} аннулировано`,
      `Название: "${entry.eventName}"`,
      `Причина: Бездействие`,
    ].join("\n"),
    buildEmptyKeyboard(),
  );

  await popQueueHead(entry.peerId);
  await promoteToActive(entry.peerId);
}

/** Автоматическое аннулирование, если модератор нажал «Аннулировать»,
 * но в течение 60 секунд не прислал причину. */
async function timeoutCancelReason(entry: EventEntry): Promise<void> {
  if ((entry.status !== "active" && entry.status !== "waiting") || !entry.cancelReasonDeadline) return;
  if (entry.cancelReasonDeadline > Date.now()) return;

  const wasActive = entry.status === "active";
  const requesterId = entry.cancelReasonRequestedBy;
  if (requesterId) await clearAwaitingReason(entry.peerId, requesterId);

  const nick = await getNick(entry.peerId, entry.ownerId);
  let displayName = nick;
  if (!displayName) {
    const users = await getUsersInfo([entry.ownerId]);
    const info = users.get(entry.ownerId);
    displayName = info ? `${info.first_name} ${info.last_name}`.trim() : entry.ownerName;
  }

  entry.status = "cancelled";
  entry.cancelReasonRequestedBy = undefined;
  entry.cancelReasonDeadline = undefined;
  entry.scheduledAt = undefined;
  entry.readyNotifiedAt = undefined;
  await saveEntry(entry);

  await editEntryMessage(
    entry,
    [
      `Мероприятие ${entry.ownerName} аннулировано`,
      `Название: "${entry.eventName}"`,
      `Причина: ${displayName} не указал причину аннулирования, но оно будет аннулировано`,
    ].join("\n"),
    buildEmptyKeyboard(),
  );

  await removeFromQueue(entry.peerId, entry.eventName, entry.id);
  if (wasActive) await promoteToActive(entry.peerId);
}

// ----------------------------------------------------
// MAINTENANCE
// ----------------------------------------------------

export async function runMaintenance(): Promise<void> {
  const chats = await getChatsWithPending();
  const now = Date.now();

  for (const peerId of chats) {
    // Восстанавливаем общую очередь из pending. Это также мигрирует старые записи,
    // созданные предыдущей версией бота с отдельными очередями по названию.
    await rebuildQueue(peerId);

    const ids = await getPendingEntryIds(peerId);
    for (const id of ids) {
      const entry = await getEntry(peerId, id);
      if (!entry) continue;

      if (entry.cancelReasonDeadline && entry.cancelReasonDeadline <= now) {
        await timeoutCancelReason(entry);
        continue;
      }

      if (entry.status === "waiting") {
        const head = await peekQueueHead(peerId);
        if (head !== entry.id) continue;

        if (entry.scheduledAt && entry.scheduledAt <= now) {
          entry.scheduledAt = undefined;
          entry.readyNotifiedAt = undefined;
          await saveEntry(entry);
          await activateEntry(peerId, entry.id);
        }
        continue;
      }

      if (entry.status === "active" && entry.activatedAt) {
        if (now - entry.activatedAt >= THIRTY_MIN_MS) {
          await timeoutEntry(entry);
          continue;
        }

        const lastReminder = entry.lastReminderAt ?? entry.activatedAt;
        if (now - lastReminder >= THREE_MIN_MS) {
          const deadline = entry.activatedAt + THIRTY_MIN_MS;
          const dm = await sendDirectMessage(
            entry.ownerId,
            `⏱️ Мероприятие «${entry.eventName}» (#${entry.id}).\n${buildDeadlineText(deadline)}`,
          );
          if (dm?.error) console.error(`[VK] Не удалось отправить ЛС пользователю ${entry.ownerId}:`, JSON.stringify(dm.error));
          entry.lastReminderAt = now;
          await saveEntry(entry);
        }
      }
    }
  }
}

// ----------------------------------------------------
// УДАЛЕНИЕ СЛУЖЕБНЫХ СООБЩЕНИЙ
// ----------------------------------------------------

export async function processPendingDeletes(): Promise<void> {
  const due = await getDueDeletes();
  console.log(`[DEBUG] processPendingDeletes: найдено к удалению = ${due.length}`);

  for (const { peerId, messageId } of due) {
    if (peerId < 2_000_000_000) {
      await clearPendingDelete(peerId, messageId);
      continue;
    }

    const result = await callVkApi("messages.delete", {
      peer_id: String(peerId),
      cmids: String(messageId),
      delete_for_all: "1",
    });

    if (result?.error) {
      console.error(`[VK] Не удалось удалить служебное сообщение cmid=${messageId}:`, JSON.stringify(result.error));
    }

    await clearPendingDelete(peerId, messageId);
  }
}
