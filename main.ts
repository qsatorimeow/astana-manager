import { redis } from "./kv.ts";
import { callVkApi, isChatPeer, sendMessageAndGetIds, getMembers, getUsersInfo, nameLinkOf } from "./vk.ts";
import { addServer, removeServer, serverExists, listServers, bindChatToServer, getChatServer, getServerChats } from "./servers.ts";
import { resolveUserRole, hasAtLeastRole, ROLE_LABEL, type AnyRole } from "./roles.ts";

const DEV = new Set((Deno.env.get("DEVELOPER_IDS") ?? "").split(",").map(x => Number(x.trim())).filter(Boolean));
const P = "b2:";
const key = (...parts: (string | number)[]) => P + parts.join(":");

function role(peer: number, user: number): Promise<{ role: AnyRole; weight: number }> {
  return resolveUserRole(peer, user, null);
}
async function can(peer: number, user: number, min: AnyRole) {
  if (DEV.has(user)) return true;
  return hasAtLeastRole(peer, user, await getChatServer(peer), min);
}
async function reply(peer: number, m: any, text: string, keyboard?: any) {
  const cmid = Number(m?.conversation_message_id ?? 0) || undefined;
  console.log(`[REPLY] peer=${peer} cmid=${cmid ?? "none"} text=${JSON.stringify(text)}`);
  return sendMessageAndGetIds(peer, text, { replyTo: cmid, keyboard });
}
async function synced(peer: number) { return (await redis.exists(key("sync", peer))) === 1; }
async function configured(peer: number) { return (await synced(peer)) && (await getChatServer(peer)) !== null; }

async function syncChat(peer: number, by: number) {
  const info = await callVkApi("messages.getConversationsById", { peer_ids: String(peer) });
  const members = await getMembers(peer);
  const settings = info?.response?.items?.[0]?.chat_settings;
  const owner = members.find((x: any) => x.isOwner);
  const record = {
    chatName: settings?.title ?? `Беседа ${peer}`,
    ownerId: Number(owner?.member_id ?? owner?.memberId ?? settings?.owner_id ?? 0),
    syncedBy: by,
    syncedAt: Date.now(),
  };
  await redis.set(key("sync", peer), record);
  await redis.sadd(key("synced_chats"), String(peer));
  return record;
}

async function handle(m: any) {
  if (!m || typeof m !== "object") {
    console.log(`[MESSAGE] invalid message object: ${typeof m}`);
    return;
  }
  const peer = Number(m.peer_id ?? 0);
  const user = Number(m.from_id ?? m.user_id ?? 0);
  console.log(`[MESSAGE RAW] peer_id=${m.peer_id ?? "missing"} from_id=${m.from_id ?? "missing"} conversation_message_id=${m.conversation_message_id ?? "missing"} text=${JSON.stringify(m.text ?? "")}`);
  if (!isChatPeer(peer) || user <= 0) {
    console.log(`[MESSAGE IGNORE] peer=${peer} user=${user} reason=not_chat_or_invalid_user`);
    return; // ЛС полностью игнорируются.
  }

  const text = String(m.text ?? "").trim();
  if (!text.startsWith("/")) return;
  const [raw, ...args] = text.split(/\s+/);
  const cmd = raw.toLowerCase();
  console.log(`[COMMAND] peer=${peer} user=${user} cmd=${cmd} args=${JSON.stringify(args)}`);

  if (cmd === "/sync") {
    if (!await can(peer, user, "deputy_spec_admin")) return reply(peer, m, "Недостаточно прав.");
    await syncChat(peer, user);
    return reply(peer, m, "Синхронизация с базой данных прошла успешно!");
  }
  if (cmd === "/delsync") {
    if (!await can(peer, user, "deputy_spec_admin")) return reply(peer, m, "Недостаточно прав.");
    await redis.del(key("sync", peer));
    await redis.srem(key("synced_chats"), String(peer));
    return reply(peer, m, "Синхронизация с базой данных удалена.");
  }
  if (cmd === "/synclist") {
    if (!await can(peer, user, "deputy_spec_admin")) return reply(peer, m, "Недостаточно прав.");
    const ids = await redis.smembers(key("synced_chats"));
    const lines = ["Список синхронизированных чатов:", ""];
    for (const id of ids ?? []) {
      const r = await redis.get<any>(key("sync", id));
      lines.push(`"${r?.chatName ?? id}" | ${r?.ownerId ? await nameLinkOf(Number(r.ownerId)) : "неизвестно"} | ${id}`);
    }
    return reply(peer, m, lines.join("\n"));
  }
  if (cmd === "/addserver") {
    if (!await can(peer, user, "spec_admin")) return reply(peer, m, "Недостаточно прав.");
    const name = args.join(" ").trim();
    if (!name) return reply(peer, m, "Вы не указали название сервера");
    if (!(await addServer(name))) return reply(peer, m, "Данный сервер уже существует");
    return reply(peer, m, `Сервер <<${name}>> добавлен в список серверов проекта`);
  }
  if (cmd === "/delserver") {
    if (!await can(peer, user, "spec_admin")) return reply(peer, m, "Недостаточно прав.");
    const name = args.join(" ").trim();
    if (!name) return reply(peer, m, "Вы не указали название сервера");
    await removeServer(name);
    return reply(peer, m, `Сервер <<${name}>> удален из списков серверов проекта`);
  }
  if (cmd === "/server") {
    if (!await can(peer, user, "spec_admin")) return reply(peer, m, "Недостаточно прав.");
    if (!await synced(peer)) return reply(peer, m, "Сначала выполните /sync");
    const name = args.join(" ").trim();
    if (!name) return reply(peer, m, "Вы не указали название сервера");
    if (!(await serverExists(name))) return reply(peer, m, "Данного сервера не существует");
    await bindChatToServer(peer, name);
    return reply(peer, m, `Вы привязали данную беседу в список бесед сервера <<${name}>>`);
  }
  if (cmd === "/servers") {
    if (!await can(peer, user, "spec_admin")) return reply(peer, m, "Недостаточно прав.");
    const names = await listServers();
    const lines = ["Список всех серверов проекта:", ""];
    for (const name of names) {
      lines.push(`Сервер <<${name}>>`);
      for (const p of await getServerChats(name)) {
        const r = await redis.get<any>(key("sync", p));
        lines.push(`"${r?.chatName ?? p}" | ${r?.ownerId ? await nameLinkOf(Number(r.ownerId)) : "неизвестно"} | ${p}`);
      }
      lines.push("");
    }
    return reply(peer, m, lines.join("\n").trim() || "Серверов нет.");
  }

  if (!await configured(peer)) {
    console.log(`[COMMAND IGNORE] peer=${peer} cmd=${cmd} reason=chat_not_configured`);
    return;
  }

  if (cmd === "/info") {
    const r = await role(peer, user);
    const rec = await redis.get<any>(key("sync", peer));
    return reply(peer, m, `Информация о беседе\nНазвание: ${rec?.chatName ?? "Неизвестно"}\nID: ${peer}\nВаша роль: ${ROLE_LABEL[r.role]}`);
  }
  if (cmd === "/help") {
    const r = await role(peer, user);
    const all = ["/info", "/help", "/stats"];
    if (r.weight >= 40) all.push("/setnick", "/removenick", "/getnick", "/getacc", "/nlist", "/staff", "/getban", "/clear");
    if (r.weight >= 50) all.push("/mute", "/unmute");
    if (r.weight >= 60) all.push("/addmoder", "/delmoder", "/timeout");
    if (r.weight >= 70) all.push("/ban", "/unban", "/banlist");
    if (r.weight >= 80) all.push("/sban", "/sunban", "/skick");
    if (r.weight >= 90) all.push("/gban", "/gunban", "/gkick");
    return reply(peer, m, "Список доступных вам команд:\n\n" + all.join("\n"));
  }
  if (cmd === "/stats") {
    const info = await getUsersInfo([user]);
    const u = info?.get?.(user) ?? info?.[0];
    const r = await role(peer, user);
    const count = Number(await redis.get(key("messages", peer, user)) ?? 0);
    const last = Number(await redis.get(key("last", peer, user)) ?? 0);
    const lastText = last ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "medium" }).format(new Date(last)) + " МСК (UTC+3)" : "Нет";
    return reply(peer, m, `Информация о пользователе ${u ? `[id${user}|${u.first_name} ${u.last_name}]` : `[id${user}|id${user}]`}\nРоль: ${ROLE_LABEL[r.role]}\nНик: ${await redis.get<string>(key("nick", peer, user)) ?? "Нет"}\nВсего сообщений: ${count}\nПоследнее сообщение: ${lastText}`);
  }

  await redis.incr(key("messages", peer, user));
  await redis.set(key("last", peer, user), String(Date.now()));
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("ok");
    const body = await req.json();
    console.log(`[WEBHOOK] type=${body?.type ?? "?"}`);
    if (body?.type === "confirmation") return new Response(Deno.env.get("VK_CONFIRMATION") ?? "");
    const secret = Deno.env.get("VK_SECRET");
    if (secret && body?.secret !== secret) return new Response("bad", { status: 403 });

    if (body?.type === "message_new") {
      let object = body?.object;
      if (typeof object === "string") {
        try { object = JSON.parse(object); } catch { console.error("[WEBHOOK] object is invalid JSON string"); }
      }
      console.log(`[WEBHOOK] object_type=${typeof object} object_keys=${object && typeof object === "object" ? Object.keys(object).join(",") : "none"}`);
      const message = object?.message ?? object?.object?.message ?? object?.object ?? object;
      console.log(`[WEBHOOK] message_found=${!!message} message_type=${typeof message}`);
      if (message) await handle(message);
    }
    return new Response("ok");
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e);
    return new Response("ok");
  }
});
