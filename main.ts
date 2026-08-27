import { redis } from "./kv.ts";
import {
  callVkApi,
  getConversationMembers,
  isChatPeer,
  nameLinkOf,
  resolveTargetUserId,
  sendMessageAndGetIds,
} from "./vk.ts";

const VK_CONFIRMATION = Deno.env.get("VK_CONFIRMATION") ?? "";
const VK_SECRET = Deno.env.get("VK_SECRET") ?? "";
const DEVELOPERS = new Set(
  (Deno.env.get("DEVELOPER_IDS") ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0),
);

const CHAT_PREFIX = "mp:chat:";
const GROUP_PREFIX = "mp:groups:";
const MOD_PREFIX = "mp:mods:";
const NICK_PREFIX = "mp:nick:";
const STAT_PREFIX = "mp:stat:";
const EVENT_PREFIX = "mp:event:";
const INPUT_PREFIX = "mp:input:";
const ALL_CHATS = "mp:known_chats";
const THIRTY_MIN = 30 * 60 * 1000;
const THREE_MIN = 3 * 60 * 1000;
const TRANSIENT_MS = 30 * 1000;

interface MpEntry {
  id: string;
  userId: number;
  title: string;
  cmid: number;
  state: "active" | "queued" | "finished";
  createdAt: number;
  startAt: number;
  deadlineAt: number;
  lastNoticeAt: number;
}

interface Stat {
  events: number;
  rollbacks: number;
  annulments: number;
}

interface InputState {
  kind: "kd" | "annul";
  eventId: string;
  userId: number;
  expiresAt: number;
}

function key(...parts: (string | number)[]) {
  return parts.join(":");
}

async function jsonGet<T>(k: string, fallback: T): Promise<T> {
  const value = await redis.get(k);
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return (typeof value === "string" ? JSON.parse(value) : value) as T;
  } catch {
    return fallback;
  }
}

async function jsonSet(k: string, value: unknown) {
  await redis.set(k, JSON.stringify(value));
}

function nowTime(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nowSeconds(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function args(text: string) {
  return text.trim().split(/\s+/).slice(1);
}

function commandOf(text: string) {
  return text.trim().split(/\s+/)[0].toLowerCase();
}

function developer(userId: number) {
  return DEVELOPERS.has(userId);
}

async function isModerator(peerId: number, userId: number) {
  if (developer(userId)) return true;
  return !!(await redis.sismember(MOD_PREFIX + peerId, String(userId)));
}

async function getNick(peerId: number, userId: number): Promise<string> {
  const nick = await redis.get(NICK_PREFIX + peerId + ":" + userId);
  if (nick) return String(nick);
  const link = await nameLinkOf(userId);
  return link;
}

async function setNick(peerId: number, userId: number, nick: string) {
  await redis.set(NICK_PREFIX + peerId + ":" + userId, nick.trim());
}

async function sendChat(peerId: number, text: string, keyboard?: object, transient = true) {
  const sent = await sendMessageAndGetIds(peerId, text, keyboard ? { keyboard: JSON.stringify(keyboard) } : undefined);
  if (transient && sent.conversationMessageId) {
    const cmid = sent.conversationMessageId;
    setTimeout(() => deleteCmid(peerId, cmid), TRANSIENT_MS);
  }
  return sent;
}

async function sendPrivate(userId: number, text: string) {
  try {
    await sendMessageAndGetIds(userId, text);
  } catch (e) {
    console.error(`[PRIVATE] Не удалось отправить ЛС user=${userId}:`, e);
  }
}

async function deleteCmid(peerId: number, cmid: number) {
  if (!cmid) return;
  try {
    await callVkApi("messages.delete", {
      peer_id: String(peerId),
      cmids: String(cmid),
      delete_for_all: "1",
    });
  } catch (e) {
    console.error(`[DELETE] peer=${peerId} cmid=${cmid}`, e);
  }
}

async function editCmid(peerId: number, cmid: number, text: string, keyboard?: object) {
  const params: Record<string, string> = {
    peer_id: String(peerId),
    conversation_message_id: String(cmid),
    message: text,
  };
  if (keyboard) params.keyboard = JSON.stringify(keyboard);
  const result = await callVkApi("messages.edit", params);
  if (result?.error) console.error(`[EDIT] peer=${peerId} cmid=${cmid}`, result.error);
}

function keyboardFor(event: MpEntry, active: boolean) {
  const buttons: any[][] = [];
  if (active) {
    buttons.push([
      { action: { type: "callback", label: "КД", payload: JSON.stringify({ a: "kd", id: event.id }) }, color: "primary" },
      { action: { type: "callback", label: "Написать КД", payload: JSON.stringify({ a: "kd_text", id: event.id }) }, color: "primary" },
    ]);
  }
  buttons.push([
    { action: { type: "callback", label: "Откат", payload: JSON.stringify({ a: "rollback", id: event.id }) }, color: "secondary" },
    { action: { type: "callback", label: "Аннулировать", payload: JSON.stringify({ a: "annul", id: event.id }) }, color: "negative" },
  ]);
  return { inline: true, buttons };
}

async function getQueue(peerId: number) {
  return await jsonGet<MpEntry[]>(CHAT_PREFIX + peerId + ":queue", []);
}

async function setQueue(peerId: number, queue: MpEntry[]) {
  await jsonSet(CHAT_PREFIX + peerId + ":queue", queue);
  await redis.sadd(ALL_CHATS, String(peerId));
}

async function getConfig(peerId: number) {
  return await jsonGet<{ synced: boolean; groupOwner: number | null; type: "admin" | "players" | null }>(
    CHAT_PREFIX + peerId + ":config",
    { synced: false, groupOwner: null, type: null },
  );
}

async function setConfig(peerId: number, config: { synced?: boolean; groupOwner?: number | null; type?: "admin" | "players" | null }) {
  const old = await getConfig(peerId);
  await jsonSet(CHAT_PREFIX + peerId + ":config", { ...old, ...config });
  await redis.sadd(ALL_CHATS, String(peerId));
}

async function getStat(peerId: number, userId: number): Promise<Stat> {
  return await jsonGet<Stat>(STAT_PREFIX + peerId + ":" + userId, { events: 0, rollbacks: 0, annulments: 0 });
}

async function changeStat(peerId: number, userId: number, field: keyof Stat) {
  const stat = await getStat(peerId, userId);
  stat[field]++;
  await jsonSet(STAT_PREFIX + peerId + ":" + userId, stat);
}

async function allUsersWithStats(peerId: number): Promise<number[]> {
  const keys: string[] = await redis.keys(STAT_PREFIX + peerId + ":*");
  return keys.map((x) => Number(x.split(":").pop())).filter((x) => Number.isFinite(x));
}

async function allModerators(peerId: number): Promise<number[]> {
  const ids = await redis.smembers(MOD_PREFIX + peerId);
  return (ids ?? []).map(Number).filter((x) => Number.isFinite(x));
}

async function activateNext(peerId: number, startAt = Date.now()) {
  const queue = await getQueue(peerId);
  const next = queue.find((x) => x.state === "queued");
  if (!next) {
    await setQueue(peerId, queue.filter((x) => x.state !== "finished"));
    return;
  }

  next.state = "active";
  next.startAt = startAt;
  next.deadlineAt = startAt + THIRTY_MIN;
  next.lastNoticeAt = 0;
  await setQueue(peerId, queue);

  await editCmid(peerId, next.cmid, `${await getNick(peerId, next.userId)} занял мероприятие\nНазвание: ${next.title}`, keyboardFor(next, true));
  await sendPrivate(next.userId, `🔔 Настала ваша очередь провести мероприятие «${next.title}».\nОсталось: 30 мин. 00 сек..\nУспейте до: ${nowTime(next.deadlineAt)}.`);
  next.lastNoticeAt = Date.now();
  await setQueue(peerId, queue);
}

async function finishRollback(peerId: number, event: MpEntry, reason?: string, byModerator?: number) {
  const queue = await getQueue(peerId);
  const idx = queue.findIndex((x) => x.id === event.id);
  if (idx < 0) return;
  const actual = queue[idx];
  actual.state = "finished";
  const at = Date.now();
  const ownerName = await getNick(peerId, actual.userId);

  if (byModerator) {
    const moderatorName = await getNick(peerId, byModerator);
    await editCmid(
      peerId,
      actual.cmid,
      `${moderatorName} откатил мероприятие ${ownerName}\nВремя отката: ${nowTime(at)}\nПричина: ${reason ?? ""}`.trim(),
    );
    await changeStat(peerId, actual.userId, "annulments");
  } else {
    await editCmid(
      peerId,
      actual.cmid,
      `${ownerName} откатил свое мероприятие\n${reason ? `Причина: ${reason}\n` : ""}Время отката: ${nowTime(at)}`.trim(),
    );
    await changeStat(peerId, actual.userId, "rollbacks");
  }

  queue.splice(idx, 1);
  await setQueue(peerId, queue);
  await activateNext(peerId, at);
}

async function finishWithKd(peerId: number, event: MpEntry, kdAt: number) {
  const queue = await getQueue(peerId);
  const idx = queue.findIndex((x) => x.id === event.id);
  if (idx < 0) return;
  const actual = queue[idx];
  actual.state = "finished";
  const ownerName = await getNick(peerId, actual.userId);
  await editCmid(peerId, actual.cmid, `${ownerName} закончил мероприятие\nНазвание: ${actual.title}\nКд: ${nowTime(kdAt)}`);
  queue.splice(idx, 1);
  await setQueue(peerId, queue);
  await activateNext(peerId, kdAt);
}

async function getEvent(peerId: number, id: string) {
  const queue = await getQueue(peerId);
  return queue.find((x) => x.id === id) ?? null;
}

async function processQueue(peerId: number) {
  const queue = await getQueue(peerId);
  const active = queue.find((x) => x.state === "active");
  if (!active) return;
  const now = Date.now();

  if (now >= active.deadlineAt) {
    await finishRollback(peerId, active, "прошло 30 мин");
    return;
  }

  if (now - active.lastNoticeAt >= THREE_MIN) {
    const remain = Math.max(0, active.deadlineAt - now);
    const minutes = Math.floor(remain / 60000);
    const seconds = Math.floor((remain % 60000) / 1000);
    await sendPrivate(
      active.userId,
      `🔔 Настала ваша очередь провести мероприятие «${active.title}».\nОсталось: ${minutes} мин. ${seconds} сек..\nУспейте до: ${nowTime(active.deadlineAt)}.`,
    );
    active.lastNoticeAt = now;
    await setQueue(peerId, queue);
  }
}

async function tick() {
  try {
    const chats = await redis.smembers(ALL_CHATS);
    for (const raw of chats ?? []) {
      const peerId = Number(raw);
      if (isChatPeer(peerId)) await processQueue(peerId);
    }
  } catch (e) {
    console.error("[TICK]", e);
  }
}

async function setupAllowed(peerId: number, userId: number) {
  const config = await getConfig(peerId);
  return developer(userId) || (config.groupOwner !== null && config.groupOwner === userId);
}

async function playerChat(peerId: number) {
  const config = await getConfig(peerId);
  return config.synced && config.groupOwner !== null && config.type === "players";
}

async function commandHelp(peerId: number, userId: number) {
  const moderator = await isModerator(peerId, userId);
  const lines = [
    "Доступные команды:",
    "/mp <название> (/мп, /евент, /ивент) — занять мероприятие",
    "/delmp — откатить своё активное/ожидающее мероприятие",
    "/top (/топ) — ТОП 10 активных администраторов",
    "/stats — статистика пользователя",
    "/nick <Nick_Name> — изменить себе ник",
  ];
  if (moderator) lines.push("/addmoder @username — добавить модератора", "/delmoder @username — снять модератора");
  if (developer(userId)) lines.push("/sync, /delsync, /addgroup, /delgroup, /mygroups, /type — настройка бота");
  return lines.join("\n");
}

async function handleCommand(peerId: number, userId: number, text: string, cmid: number, replyFromId?: number) {
  const command = commandOf(text);
  const a = args(text);
  const aliases: Record<string, string> = { "/мп": "/mp", "/евент": "/mp", "/ивент": "/mp", "/топ": "/top" };
  const cmd = aliases[command] ?? command;

  if (cmd === "/help") {
    await sendChat(peerId, await commandHelp(peerId, userId));
    return;
  }

  if (cmd === "/sync") {
    if (!developer(userId)) return void await sendChat(peerId, "Недостаточно прав.");
    await setConfig(peerId, { synced: true });
    return void await sendChat(peerId, "Синхронизация с базой данных прошла успешно!\nТеперь добавьте беседу пользователю через /addgroup.");
  }

  if (cmd === "/delsync") {
    if (!developer(userId)) return void await sendChat(peerId, "Недостаточно прав.");
    await setConfig(peerId, { synced: false, groupOwner: null, type: null });
    return void await sendChat(peerId, "Синхронизация с базой данных удалена.");
  }

  if (cmd === "/addgroup") {
    if (!developer(userId) && !(await setupAllowed(peerId, userId))) return void await sendChat(peerId, "Недостаточно прав.");
    const config = await getConfig(peerId);
    if (!config.synced) return void await sendChat(peerId, "Сначала выполните /sync.");
    if (config.groupOwner !== null) return void await sendChat(peerId, "Эта беседа уже добавлена пользователю.");
    await setConfig(peerId, { groupOwner: userId });
    await redis.sadd(GROUP_PREFIX + userId, String(peerId));
    return void await sendChat(peerId, "Данная беседа добавлена в список ваших чатов.\nТеперь выберите тип беседы через /type.");
  }

  if (cmd === "/delgroup") {
    if (!(await setupAllowed(peerId, userId))) return void await sendChat(peerId, "Недостаточно прав.");
    const config = await getConfig(peerId);
    if (config.groupOwner !== null) await redis.srem(GROUP_PREFIX + config.groupOwner, String(peerId));
    await setConfig(peerId, { groupOwner: null, type: null });
    return void await sendChat(peerId, "Данная беседа удалена из списка пользователя.");
  }

  if (cmd === "/mygroups") {
    const ids = await redis.smembers(GROUP_PREFIX + userId);
    const textOut = (ids ?? []).length
      ? "Список ваших чатов:\n" + (ids ?? []).map((x) => `Беседа ${Number(x) - 2000000000}`).join("\n")
      : "Список ваших чатов:\nОтсутствуют";
    return void await sendChat(peerId, textOut);
  }

  if (cmd === "/type") {
    if (!(await setupAllowed(peerId, userId))) return void await sendChat(peerId, "Недостаточно прав.");
    const config = await getConfig(peerId);
    if (!config.synced || config.groupOwner === null) return void await sendChat(peerId, "Сначала выполните /sync и /addgroup.");
    const keyboard = {
      inline: true,
      buttons: [[
        { action: { type: "callback", label: "Административный чат", payload: JSON.stringify({ a: "type", v: "admin", u: userId }) }, color: "primary" },
        { action: { type: "callback", label: "Беседа игроков", payload: JSON.stringify({ a: "type", v: "players", u: userId }) }, color: "positive" },
      ]],
    };
    return void await sendChat(peerId, "Выберите тип беседы:", keyboard);
  }

  if (cmd === "/addmoder" || cmd === "/delmoder") {
    if (!(await isModerator(peerId, userId))) return void await sendChat(peerId, "Недостаточно прав.");
    const target = await resolveTargetUserId(a[0] ?? "");
    if (!target) return void await sendChat(peerId, "Укажите пользователя: /addmoder @username");
    if (developer(target)) return void await sendChat(peerId, "Разработчика нельзя изменить этой командой.");
    if (cmd === "/addmoder") {
      await redis.sadd(MOD_PREFIX + peerId, String(target));
      return void await sendChat(peerId, `${await getNick(peerId, target)} добавлен в список модераторов.`);
    }
    await redis.srem(MOD_PREFIX + peerId, String(target));
    return void await sendChat(peerId, `${await getNick(peerId, target)} снят с роли модератора.`);
  }

  if (["/mp", "/delmp", "/top", "/stats", "/nick"].includes(cmd) && !(await playerChat(peerId))) {
    return void await sendChat(peerId, "Бот ещё не настроен как «Беседа игроков». Выполните: /sync → /addgroup → /type.");
  }

  if (cmd === "/nick") {
    const nick = a.join(" ").trim();
    if (!nick) return void await sendChat(peerId, "Формат: /nick Nick_Name");
    await setNick(peerId, userId, nick);
    return void await sendChat(peerId, "Вы изменили себе ник нейм.");
  }

  if (cmd === "/mp") {
    const title = a.join(" ").trim();
    if (!title) return void await sendChat(peerId, "Формат: /mp название мероприятия");
    const queue = await getQueue(peerId);
    if (queue.some((x) => x.userId === userId && x.state !== "finished")) {
      return void await sendChat(peerId, "У вас уже есть мероприятие в очереди.");
    }
    const id = crypto.randomUUID();
    const active = queue.find((x) => x.state === "active");
    const event: MpEntry = {
      id,
      userId,
      title,
      cmid: 0,
      state: active ? "queued" : "active",
      createdAt: Date.now(),
      startAt: active ? 0 : Date.now(),
      deadlineAt: active ? 0 : Date.now() + THIRTY_MIN,
      lastNoticeAt: 0,
    };

    const initialText = `${await getNick(peerId, userId)} занял мероприятие\nНазвание: ${title}`;
    const sent = await sendChat(peerId, initialText, keyboardFor(event, !active), false);
    event.cmid = sent.conversationMessageId ?? 0;
    queue.push(event);
    await setQueue(peerId, queue);
    await jsonSet(EVENT_PREFIX + id, { peerId, userId });
    await changeStat(peerId, userId, "events");

    if (!active) {
      await editCmid(peerId, event.cmid, initialText, keyboardFor(event, true));
      await sendPrivate(userId, `🔔 Настала ваша очередь провести мероприятие «${title}».\nОсталось: 30 мин. 00 сек..\nУспейте до: ${nowTime(event.deadlineAt)}.`);
      event.lastNoticeAt = Date.now();
      await setQueue(peerId, queue);
    }
    return;
  }

  if (cmd === "/delmp") {
    const queue = await getQueue(peerId);
    const own = queue.find((x) => x.userId === userId && x.state !== "finished");
    if (!own) return void await sendChat(peerId, "У вас нет активного мероприятия.");
    if (own.state === "active") await finishRollback(peerId, own, undefined);
    else {
      await setQueue(peerId, queue.filter((x) => x.id !== own.id));
      await editCmid(peerId, own.cmid, `${await getNick(peerId, userId)} удалил свое мероприятие из очереди.`);
    }
    return;
  }

  if (cmd === "/top") {
    const mods = await allModerators(peerId);
    const rows: { id: number; events: number }[] = [];
    for (const id of mods) rows.push({ id, events: (await getStat(peerId, id)).events });
    rows.sort((a, b) => b.events - a.events);
    const medals = ["🥇", "🥈", "🥉", "🎖", "🎖", "🎖", "🎖", "🎖", "🎖", "🎖"];
    let out = "🏆 ТОП 10 активных администраторов по мероприятиям\n\n";
    for (let i = 0; i < Math.min(10, rows.length); i++) out += `${medals[i]} ${await getNick(peerId, rows[i].id)} мероприятий: ${rows[i].events}\n`;
    const all = await allUsersWithStats(peerId);
    let total = 0;
    for (const id of all) total += (await getStat(peerId, id)).events;
    out += `\nВсего мероприятий в чате: ${total}`;
    return void await sendChat(peerId, out);
  }

  if (cmd === "/stats") {
    const target = replyFromId ?? (await resolveTargetUserId(a[0] ?? "")) ?? userId;
    const stat = await getStat(peerId, target);
    const mods = await allModerators(peerId);
    const ranking: { id: number; events: number }[] = [];
    for (const id of mods) ranking.push({ id, events: (await getStat(peerId, id)).events });
    ranking.sort((a, b) => b.events - a.events);
    const place = ranking.findIndex((x) => x.id === target) + 1;
    const link = await nameLinkOf(target);
    const out = `Статистика пользователя${link}\nМероприятий: ${stat.events}\nВсего откатов: ${stat.rollbacks}\nВсего аннулирований: ${stat.annulments}\nВ списке топов: ${place > 0 ? place : "не состоит"}`;
    return void await sendChat(peerId, out);
  }
}

async function handleMessage(body: any) {
  const raw = body?.object;
  const m = raw?.message ?? raw;
  if (!m || typeof m !== "object") return;
  const peerId = Number(m.peer_id);
  const userId = Number(m.from_id);
  const text = String(m.text ?? "").trim();
  if (!isChatPeer(peerId)) return;

  const cmid = Number(m.conversation_message_id ?? 0);
  console.log(`[VK] message_new peer=${peerId} from=${userId} text=${JSON.stringify(text.slice(0, 100))}`);

  await processQueue(peerId);

  const config = await getConfig(peerId);
  const inputKey = INPUT_PREFIX + peerId + ":" + userId;
  const input = await jsonGet<InputState | null>(inputKey, null);

  if (input && Date.now() < input.expiresAt && !text.startsWith("/")) {
    const event = await getEvent(peerId, input.eventId);
    if (event && event.state === "active") {
      if (input.kind === "kd") {
        const parsed = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!parsed) {
          await editCmid(peerId, event.cmid, "Напишите КД мероприятий в формате ЧЧ:ММ");
          return;
        }
        const d = new Date();
        d.setHours(Number(parsed[1]), Number(parsed[2]), 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        await redis.del(inputKey);
        await finishWithKd(peerId, event, d.getTime());
        return;
      }
      if (input.kind === "annul") {
        await redis.del(inputKey);
        await finishRollback(peerId, event, text, input.userId);
        return;
      }
    }
    await redis.del(inputKey);
  }

  if (text.startsWith("/")) {
    const replyFromId = Number(m.reply_message?.from_id ?? 0) || undefined;
    await handleCommand(peerId, userId, text, cmid, replyFromId);
  }
}

async function handleCallback(body: any) {
  const o = body?.object ?? {};
  const peerId = Number(o.peer_id);
  const userId = Number(o.user_id);
  if (!isChatPeer(peerId)) {
    await callVkApi("messages.sendMessageEventAnswer", {
      event_id: String(o.event_id),
      user_id: String(userId),
      peer_id: String(peerId),
      event_data: JSON.stringify({ type: "show_snackbar", text: "Бот работает только в беседах" }),
    });
    return;
  }

  let payload: any = null;
  try { payload = typeof o.payload === "string" ? JSON.parse(o.payload) : o.payload; } catch { payload = null; }

  const answer = async (text: string) => {
    await callVkApi("messages.sendMessageEventAnswer", {
      event_id: String(o.event_id),
      user_id: String(userId),
      peer_id: String(peerId),
      event_data: JSON.stringify({ type: "show_snackbar", text }),
    });
  };

  if (payload?.a === "type") {
    const config = await getConfig(peerId);
    if (!(developer(userId) || config.groupOwner === userId)) return void await answer("Только владелец добавленной беседы может выбрать тип");
    await setConfig(peerId, { type: payload.v === "players" ? "players" : "admin" });
    await answer("Тип беседы сохранён");
    return;
  }

  const eventId = String(payload?.id ?? "");
  const event = await getEvent(peerId, eventId);
  if (!event) return void await answer("Мероприятие уже завершено");

  if (payload?.a === "annul") {
    if (!(await isModerator(peerId, userId))) return void await answer("Аннулировать может только модератор");
    if (event.state !== "active") return void await answer("Сейчас не ваша очередь");
    await editCmid(peerId, event.cmid, "Напишите причину аннулирование:");
    const state: InputState = { kind: "annul", eventId, userId, expiresAt: Date.now() + 120000 };
    await jsonSet(INPUT_PREFIX + peerId + ":" + userId, state);
    return void await answer("Ожидаю причину");
  }

  if (event.userId !== userId) return void await answer("Взаимодействовать с этим мероприятием может только его владелец");
  if (event.state !== "active") return void await answer("Сейчас не ваша очередь");

  if (payload?.a === "rollback") {
    await answer("Мероприятие откатывается");
    await finishRollback(peerId, event);
    return;
  }

  if (payload?.a === "kd") {
    const kd = Date.now() + 10 * 60 * 1000;
    await answer("КД установлено");
    await finishWithKd(peerId, event, kd);
    return;
  }

  if (payload?.a === "kd_text") {
    await editCmid(peerId, event.cmid, "Напишите кд мероприятий");
    await jsonSet(INPUT_PREFIX + peerId + ":" + userId, { kind: "kd", eventId, userId, expiresAt: Date.now() + 120000 } satisfies InputState);
    await answer("Ожидаю время КД");
  }
}

async function alreadyProcessed(id: string | undefined) {
  if (!id) return false;
  const k = "mp:processed:" + id;
  const exists = await redis.get(k);
  if (exists) return true;
  await redis.set(k, "1", { ex: 3600 });
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Bot is running", { status: 200 });

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    console.error("[WEBHOOK] invalid JSON", e);
    return new Response("bad", { status: 400 });
  }

  console.log(`[WEBHOOK] type=${body?.type ?? "unknown"}`);

  if (body?.type === "confirmation") {
    return new Response(VK_CONFIRMATION, { status: 200 });
  }

  if (VK_SECRET && body?.secret !== VK_SECRET) return new Response("invalid secret", { status: 403 });
  if (await alreadyProcessed(body?.event_id)) return new Response("ok", { status: 200 });

  try {
    if (body?.type === "message_new") await handleMessage(body);
    else if (body?.type === "message_event") await handleCallback(body);
  } catch (e) {
    console.error("[WEBHOOK] handler error", e);
  }

  return new Response("ok", { status: 200 });
});

setInterval(() => { void tick(); }, 60_000);
void tick();
