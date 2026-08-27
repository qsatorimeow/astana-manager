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

const CHAT = "mp:chat:";
const GROUPS = "mp:groups:";
const MODS = "mp:mods:";
const NICK = "mp:nick:";
const STAT = "mp:stat:";
const INPUT = "mp:input:";
const KNOWN = "mp:known_chats";
const THIRTY_MIN = 30 * 60 * 1000;
const THREE_MIN = 3 * 60 * 1000;
const TRANSIENT = 30 * 1000;

interface MpEntry {
  id: string;
  userId: number;
  title: string;
  cmid: number;
  state: "active" | "queued";
  createdAt: number;
  startAt: number;
  deadlineAt: number;
  lastNoticeAt: number;
}

interface Stat { events: number; rollbacks: number; annulments: number; }
interface InputState { kind: "kd" | "annul"; eventId: string; userId: number; expiresAt: number; }
interface Config { synced: boolean; groupOwner: number | null; type: "admin" | "players" | null; }

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try { return (typeof value === "string" ? JSON.parse(value) : value) as T; } catch { return fallback; }
}
async function getJson<T>(k: string, fallback: T): Promise<T> { return json(await redis.get(k), fallback); }
async function putJson(k: string, value: unknown) { await redis.set(k, JSON.stringify(value)); }
function dev(id: number) { return DEVELOPERS.has(id); }
function cmd(text: string) { return text.trim().split(/\s+/)[0].toLowerCase(); }
function args(text: string) { return text.trim().split(/\s+/).slice(1); }
function clock(ms: number) { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; }

async function isModerator(peerId: number, userId: number) {
  return dev(userId) || !!(await redis.sismember(MODS + peerId, String(userId)));
}

async function nick(peerId: number, userId: number) {
  const saved = await redis.get(NICK + peerId + ":" + userId);
  return saved ? String(saved) : await nameLinkOf(userId);
}

async function sendChat(peerId: number, text: string, keyboard?: object, transient = true) {
  const sent = await sendMessageAndGetIds(peerId, text, keyboard ? { keyboard: JSON.stringify(keyboard) } : undefined);
  if (transient && sent.conversationMessageId) setTimeout(() => void deleteCmid(peerId, sent.conversationMessageId!), TRANSIENT);
  return sent;
}

async function sendPrivate(userId: number, text: string) {
  try { await sendMessageAndGetIds(userId, text); } catch (e) { console.error(`[PRIVATE] user=${userId}`, e); }
}

async function deleteCmid(peerId: number, cmid: number) {
  if (!cmid) return;
  await callVkApi("messages.delete", { peer_id: String(peerId), cmids: String(cmid), delete_for_all: "1" });
}

async function edit(peerId: number, cmid: number, text: string, keyboard?: object) {
  if (!cmid) return;
  const p: Record<string, string> = { peer_id: String(peerId), conversation_message_id: String(cmid), message: text };
  if (keyboard) p.keyboard = JSON.stringify(keyboard);
  await callVkApi("messages.edit", p);
}

function keyboard(event: MpEntry, active: boolean) {
  const buttons: any[][] = [];
  if (active) buttons.push([
    { action: { type: "callback", label: "КД", payload: JSON.stringify({ a: "kd", id: event.id }) }, color: "primary" },
    { action: { type: "callback", label: "Написать КД", payload: JSON.stringify({ a: "kd_text", id: event.id }) }, color: "primary" },
  ]);
  buttons.push([
    { action: { type: "callback", label: "Откат", payload: JSON.stringify({ a: "rollback", id: event.id }) }, color: "secondary" },
    { action: { type: "callback", label: "Аннулировать", payload: JSON.stringify({ a: "annul", id: event.id }) }, color: "negative" },
  ]);
  return { inline: true, buttons };
}

async function queue(peerId: number): Promise<MpEntry[]> { return getJson(CHAT + peerId + ":queue", []); }
async function saveQueue(peerId: number, q: MpEntry[]) { await putJson(CHAT + peerId + ":queue", q); await redis.sadd(KNOWN, String(peerId)); }
async function config(peerId: number): Promise<Config> { return getJson(CHAT + peerId + ":config", { synced: false, groupOwner: null, type: null }); }
async function saveConfig(peerId: number, patch: Partial<Config>) { await putJson(CHAT + peerId + ":config", { ...(await config(peerId)), ...patch }); await redis.sadd(KNOWN, String(peerId)); }
async function stat(peerId: number, userId: number): Promise<Stat> { return getJson(STAT + peerId + ":" + userId, { events: 0, rollbacks: 0, annulments: 0 }); }
async function incStat(peerId: number, userId: number, field: keyof Stat) { const s = await stat(peerId, userId); s[field]++; await putJson(STAT + peerId + ":" + userId, s); }

async function ownerId(peerId: number) {
  const members = await getConversationMembers(peerId);
  return members.find((x) => x.isOwner)?.memberId ?? null;
}

async function playerChat(peerId: number) {
  const c = await config(peerId);
  return c.synced && c.groupOwner !== null && c.type === "players";
}

async function activateDue(peerId: number) {
  const q = await queue(peerId);
  const active = q.find((x) => x.state === "active");
  if (active) return;
  const now = Date.now();
  const next = q.find((x) => x.state === "queued" && (x.startAt === 0 || x.startAt <= now));
  if (!next) return;
  next.state = "active";
  next.startAt = next.startAt || now;
  next.deadlineAt = next.deadlineAt || next.startAt + THIRTY_MIN;
  next.lastNoticeAt = now;
  await saveQueue(peerId, q);
  await edit(peerId, next.cmid, `${await nick(peerId, next.userId)} занял мероприятие\nНазвание: ${next.title}`, keyboard(next, true));
  await sendPrivate(next.userId, `🔔 Настала ваша очередь провести мероприятие «${next.title}».\nОсталось: 30 мин. 00 сек..\nУспейте до: ${clock(next.deadlineAt)}.`);
}

async function finishRollback(peerId: number, event: MpEntry, reason?: string, moderatorId?: number) {
  const q = await queue(peerId);
  const i = q.findIndex((x) => x.id === event.id);
  if (i < 0) return;
  const e = q[i];
  const at = Date.now();
  const owner = await nick(peerId, e.userId);
  if (moderatorId) {
    await edit(peerId, e.cmid, `${await nick(peerId, moderatorId)} откатил мероприятие ${owner}\nВремя отката: ${clock(at)}\nПричина: ${reason ?? ""}`.trim());
    await incStat(peerId, e.userId, "annulments");
  } else {
    await edit(peerId, e.cmid, `${owner} откатил свое мероприятие\n${reason ? `Причина: ${reason}\n` : ""}Время отката: ${clock(at)}`.trim());
    await incStat(peerId, e.userId, "rollbacks");
  }
  q.splice(i, 1);
  await saveQueue(peerId, q);
  await activateDue(peerId);
}

async function finishKd(peerId: number, event: MpEntry, kdAt: number) {
  const q = await queue(peerId);
  const i = q.findIndex((x) => x.id === event.id);
  if (i < 0) return;
  const e = q[i];
  await edit(peerId, e.cmid, `${await nick(peerId, e.userId)} закончил мероприятие\nНазвание: ${e.title}\nКд: ${clock(kdAt)}`);
  q.splice(i, 1);
  const next = q.find((x) => x.state === "queued");
  if (next) {
    next.startAt = kdAt;
    next.deadlineAt = kdAt + THIRTY_MIN;
  }
  await saveQueue(peerId, q);
  await activateDue(peerId);
}

async function processChat(peerId: number) {
  await activateDue(peerId);
  const q = await queue(peerId);
  const active = q.find((x) => x.state === "active");
  if (!active) return;
  const now = Date.now();
  if (now >= active.deadlineAt) { await finishRollback(peerId, active, "прошло 30 мин"); return; }
  if (now - active.lastNoticeAt >= THREE_MIN) {
    const remain = Math.max(0, active.deadlineAt - now);
    const min = Math.floor(remain / 60000);
    const sec = Math.floor((remain % 60000) / 1000);
    await sendPrivate(active.userId, `🔔 Настала ваша очередь провести мероприятие «${active.title}».\nОсталось: ${min} мин. ${sec} сек..\nУспейте до: ${clock(active.deadlineAt)}.`);
    active.lastNoticeAt = now;
    await saveQueue(peerId, q);
  }
}

async function tick() {
  try {
    for (const raw of (await redis.smembers(KNOWN)) ?? []) {
      const p = Number(raw);
      if (isChatPeer(p)) await processChat(p);
    }
  } catch (e) { console.error("[TICK]", e); }
}

async function help(peerId: number, userId: number) {
  const lines = [
    "Доступные команды:",
    "/mp <название> (/мп, /евент, /ивент) — занять мероприятие",
    "/delmp — удалить/откатить своё мероприятие",
    "/top (/топ) — ТОП 10 активных администраторов",
    "/stats — статистика пользователя",
    "/nick <Nick_Name> — сменить себе ник",
  ];
  if (await isModerator(peerId, userId)) lines.push("/addmoder @username", "/delmoder @username");
  if (dev(userId)) lines.push("/sync, /delsync, /addgroup, /delgroup, /mygroups, /type");
  return lines.join("\n");
}

async function command(peerId: number, userId: number, text: string, cmid: number, replyFromId?: number) {
  const raw = cmd(text);
  const aliases: Record<string, string> = { "/мп": "/mp", "/евент": "/mp", "/ивент": "/mp", "/топ": "/top" };
  const c = aliases[raw] ?? raw;
  const a = args(text);

  if (c === "/help") return void await sendChat(peerId, await help(peerId, userId));

  if (c === "/sync") {
    if (!dev(userId)) return void await sendChat(peerId, "Недостаточно прав.");
    await saveConfig(peerId, { synced: true });
    return void await sendChat(peerId, "Синхронизация с базой данных прошла успешно!\nТеперь выполните /addgroup.");
  }
  if (c === "/delsync") {
    if (!dev(userId)) return void await sendChat(peerId, "Недостаточно прав.");
    const old = await config(peerId);
    if (old.groupOwner !== null) await redis.srem(GROUPS + old.groupOwner, String(peerId));
    await saveConfig(peerId, { synced: false, groupOwner: null, type: null });
    return void await sendChat(peerId, "Синхронизация с базой данных удалена.");
  }
  if (c === "/addgroup") {
    const current = await config(peerId);
    const vkOwner = await ownerId(peerId);
    if (!dev(userId) && vkOwner !== userId) return void await sendChat(peerId, "Добавить беседу может владелец беседы или разработчик.");
    if (!current.synced) return void await sendChat(peerId, "Сначала выполните /sync.");
    if (current.groupOwner !== null) return void await sendChat(peerId, "Эта беседа уже добавлена пользователю.");
    await saveConfig(peerId, { groupOwner: userId });
    await redis.sadd(GROUPS + userId, String(peerId));
    return void await sendChat(peerId, "Данная беседа добавлена в список ваших чатов.\nТеперь выполните /type.");
  }
  if (c === "/delgroup") {
    const current = await config(peerId);
    if (!dev(userId) && current.groupOwner !== userId) return void await sendChat(peerId, "Недостаточно прав.");
    if (current.groupOwner !== null) await redis.srem(GROUPS + current.groupOwner, String(peerId));
    await saveConfig(peerId, { groupOwner: null, type: null });
    return void await sendChat(peerId, "Данная беседа удалена из списка ваших чатов.");
  }
  if (c === "/mygroups") {
    const ids = await redis.smembers(GROUPS + userId);
    const out = (ids ?? []).length ? "Список ваших чатов:\n" + (ids ?? []).map((x) => `Беседа ${Number(x) - 2000000000}`).join("\n") : "Список ваших чатов:\nОтсутствуют";
    return void await sendChat(peerId, out);
  }
  if (c === "/type") {
    const current = await config(peerId);
    if (!dev(userId) && current.groupOwner !== userId) return void await sendChat(peerId, "Недостаточно прав.");
    if (!current.synced || current.groupOwner === null) return void await sendChat(peerId, "Сначала выполните /sync → /addgroup.");
    const kb = { inline: true, buttons: [[
      { action: { type: "callback", label: "Административный чат", payload: JSON.stringify({ a: "type", v: "admin" }) }, color: "primary" },
      { action: { type: "callback", label: "Беседа игроков", payload: JSON.stringify({ a: "type", v: "players" }) }, color: "positive" },
    ]] };
    return void await sendChat(peerId, "Выберите тип беседы:", kb);
  }

  if (c === "/addmoder" || c === "/delmoder") {
    if (!(await isModerator(peerId, userId))) return void await sendChat(peerId, "Недостаточно прав.");
    const target = await resolveTargetUserId(a[0] ?? "");
    if (!target) return void await sendChat(peerId, "Формат: /addmoder @username");
    if (dev(target)) return void await sendChat(peerId, "Разработчика нельзя изменить этой командой.");
    if (c === "/addmoder") {
      await redis.sadd(MODS + peerId, String(target));
      return void await sendChat(peerId, `${await nick(peerId, target)} добавлен в список модераторов.`);
    }
    await redis.srem(MODS + peerId, String(target));
    return void await sendChat(peerId, `${await nick(peerId, target)} снят с роли модератора.`);
  }

  if (["/mp", "/delmp", "/top", "/stats", "/nick"].includes(c) && !(await playerChat(peerId))) {
    return void await sendChat(peerId, "Бот ещё не настроен как «Беседа игроков». Выполните: /sync → /addgroup → /type.");
  }

  if (c === "/nick") {
    const n = a.join(" ").trim();
    if (!n) return void await sendChat(peerId, "Формат: /nick Nick_Name");
    await redis.set(NICK + peerId + ":" + userId, n);
    return void await sendChat(peerId, "Вы изменили себе ник нейм.");
  }

  if (c === "/mp") {
    const title = a.join(" ").trim();
    if (!title) return void await sendChat(peerId, "Формат: /mp название мероприятия");
    const q = await queue(peerId);
    if (q.some((x) => x.userId === userId)) return void await sendChat(peerId, "У вас уже есть мероприятие в очереди.");
    const active = q.find((x) => x.state === "active");
    const now = Date.now();
    const e: MpEntry = { id: crypto.randomUUID(), userId, title, cmid: 0, state: active ? "queued" : "active", createdAt: now, startAt: active ? 0 : now, deadlineAt: active ? 0 : now + THIRTY_MIN, lastNoticeAt: 0 };
    const sent = await sendChat(peerId, `${await nick(peerId, userId)} занял мероприятие\nНазвание: ${title}`, keyboard(e, !active), false);
    e.cmid = sent.conversationMessageId ?? 0;
    q.push(e);
    await saveQueue(peerId, q);
    await incStat(peerId, userId, "events");
    if (!active) {
      await edit(peerId, e.cmid, `${await nick(peerId, userId)} занял мероприятие\nНазвание: ${title}`, keyboard(e, true));
      await sendPrivate(userId, `🔔 Настала ваша очередь провести мероприятие «${title}».\nОсталось: 30 мин. 00 сек..\nУспейте до: ${clock(e.deadlineAt)}.`);
      e.lastNoticeAt = Date.now();
      await saveQueue(peerId, q);
    }
    return;
  }

  if (c === "/delmp") {
    const q = await queue(peerId);
    const e = q.find((x) => x.userId === userId);
    if (!e) return void await sendChat(peerId, "У вас нет активного мероприятия.");
    if (e.state === "active") await finishRollback(peerId, e);
    else {
      await edit(peerId, e.cmid, `${await nick(peerId, userId)} удалил свое мероприятие из очереди.`);
      await saveQueue(peerId, q.filter((x) => x.id !== e.id));
    }
    return;
  }

  if (c === "/top") {
    const mods = (await redis.smembers(MODS + peerId) ?? []).map(Number).filter((x) => Number.isFinite(x));
    const rows: { id: number; events: number }[] = [];
    for (const id of mods) rows.push({ id, events: (await stat(peerId, id)).events });
    rows.sort((a, b) => b.events - a.events);
    const medal = ["🥇", "🥈", "🥉", "🎖", "🎖", "🎖", "🎖", "🎖", "🎖", "🎖"];
    let out = "🏆 ТОП 10 активных администраторов по мероприятиям\n\n";
    for (let i = 0; i < Math.min(10, rows.length); i++) out += `${medal[i]} ${await nick(peerId, rows[i].id)} мероприятий: ${rows[i].events}\n`;
    const keys = await redis.keys(STAT + peerId + ":*");
    let total = 0;
    for (const k of keys) total += (await getJson<Stat>(k, { events: 0, rollbacks: 0, annulments: 0 })).events;
    out += `\nВсего мероприятий в чате: ${total}`;
    return void await sendChat(peerId, out);
  }

  if (c === "/stats") {
    const target = replyFromId ?? (await resolveTargetUserId(a[0] ?? "")) ?? userId;
    const s = await stat(peerId, target);
    const mods = (await redis.smembers(MODS + peerId) ?? []).map(Number).filter((x) => Number.isFinite(x));
    const ranking: { id: number; events: number }[] = [];
    for (const id of mods) ranking.push({ id, events: (await stat(peerId, id)).events });
    ranking.sort((a, b) => b.events - a.events);
    const place = ranking.findIndex((x) => x.id === target) + 1;
    return void await sendChat(peerId, `Статистика пользователя${await nameLinkOf(target)}\nМероприятий: ${s.events}\nВсего откатов: ${s.rollbacks}\nВсего аннулирований: ${s.annulments}\nВ списке топов: ${place > 0 ? place : "не состоит"}`);
  }
}

async function handleMessage(body: any) {
  const raw = body?.object;
  const m = raw?.message ?? raw;
  if (!m || typeof m !== "object") return;
  const peerId = Number(m.peer_id);
  const userId = Number(m.from_id);
  if (!isChatPeer(peerId)) return;
  const text = String(m.text ?? "").trim();
  const cmid = Number(m.conversation_message_id ?? 0);
  console.log(`[VK] message_new peer=${peerId} from=${userId} text=${JSON.stringify(text.slice(0, 100))}`);

  await processChat(peerId);
  const pending = await getJson<InputState | null>(INPUT + peerId + ":" + userId, null);
  if (pending && pending.expiresAt > Date.now() && !text.startsWith("/")) {
    const q = await queue(peerId);
    const e = q.find((x) => x.id === pending.eventId);
    if (e && e.state === "active") {
      if (pending.kind === "annul") {
        await redis.del(INPUT + peerId + ":" + userId);
        await finishRollback(peerId, e, text, userId);
        return;
      }
      const match = text.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) { await edit(peerId, e.cmid, "Напишите кд мероприятий в формате ЧЧ:ММ"); return; }
      const d = new Date();
      d.setHours(Number(match[1]), Number(match[2]), 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      await redis.del(INPUT + peerId + ":" + userId);
      await finishKd(peerId, e, d.getTime());
      return;
    }
    await redis.del(INPUT + peerId + ":" + userId);
  }

  if (text.startsWith("/")) await command(peerId, userId, text, cmid, Number(m.reply_message?.from_id ?? 0) || undefined);
}

async function handleCallback(body: any) {
  const o = body?.object ?? {};
  const peerId = Number(o.peer_id);
  const userId = Number(o.user_id);
  const answer = async (text: string) => {
    await callVkApi("messages.sendMessageEventAnswer", { event_id: String(o.event_id), user_id: String(userId), peer_id: String(peerId), event_data: JSON.stringify({ type: "show_snackbar", text }) });
  };
  if (!isChatPeer(peerId)) return void await answer("Бот работает только в беседах");

  let p: any = null;
  try { p = typeof o.payload === "string" ? JSON.parse(o.payload) : o.payload; } catch { p = null; }

  if (p?.a === "type") {
    const c = await config(peerId);
    if (!dev(userId) && c.groupOwner !== userId) return void await answer("Недостаточно прав");
    await saveConfig(peerId, { type: p.v === "players" ? "players" : "admin" });
    return void await answer("Тип беседы сохранён");
  }

  const e = (await queue(peerId)).find((x) => x.id === String(p?.id ?? ""));
  if (!e) return void await answer("Мероприятие уже завершено");

  if (p?.a === "annul") {
    if (!(await isModerator(peerId, userId))) return void await answer("Аннулировать может только модератор");
    if (e.state !== "active") return void await answer("Мероприятие ещё не началось");
    await edit(peerId, e.cmid, "Напишите причину аннулирование:");
    await putJson(INPUT + peerId + ":" + userId, { kind: "annul", eventId: e.id, userId, expiresAt: Date.now() + 120000 } satisfies InputState);
    return void await answer("Ожидаю причину");
  }

  if (e.userId !== userId) return void await answer("Взаимодействовать с этим мероприятием может только его владелец");
  if (e.state !== "active") return void await answer("Сейчас не ваша очередь");

  if (p?.a === "rollback") { await answer("Откат выполнен"); return void await finishRollback(peerId, e); }
  if (p?.a === "kd") { await answer("КД установлено"); return void await finishKd(peerId, e, Date.now() + 10 * 60 * 1000); }
  if (p?.a === "kd_text") {
    await edit(peerId, e.cmid, "Напишите кд мероприятий");
    await putJson(INPUT + peerId + ":" + userId, { kind: "kd", eventId: e.id, userId, expiresAt: Date.now() + 120000 } satisfies InputState);
    return void await answer("Ожидаю время КД");
  }
}

async function processed(eventId?: string) {
  if (!eventId) return false;
  const k = "mp:processed:" + eventId;
  if (await redis.get(k)) return true;
  await redis.set(k, "1", { ex: 3600 });
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Bot is running", { status: 200 });
  let body: any;
  try { body = await req.json(); } catch (e) { console.error("[WEBHOOK] invalid JSON", e); return new Response("bad", { status: 400 }); }
  console.log(`[WEBHOOK] type=${body?.type ?? "unknown"}`);
  if (body?.type === "confirmation") return new Response(VK_CONFIRMATION, { status: 200 });
  if (VK_SECRET && body?.secret !== VK_SECRET) return new Response("invalid secret", { status: 403 });
  if (await processed(body?.event_id)) return new Response("ok", { status: 200 });
  try {
    if (body?.type === "message_new") await handleMessage(body);
    else if (body?.type === "message_event") await handleCallback(body);
  } catch (e) { console.error("[WEBHOOK] handler error", e); }
  return new Response("ok", { status: 200 });
});

setInterval(() => void tick(), 60_000);
void tick();
