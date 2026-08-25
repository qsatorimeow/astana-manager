// /staff — полный список рангов беседы. /help и /alt — справка по командам.
import { getConversationMembers, getUsersInfo, nameLinkOfAny, profileLink } from "./vk.ts";
import {
  type AnyRole,
  CHAT_ROLES,
  getChatRoleMembers,
  getGlobalRoleMembers,
  ROLE_WEIGHT,
} from "./roles.ts";

export async function buildStaffMessage(peerId: number): Promise<string> {
  const [members, specAdmins, deputyAdmins, ...chatRoleMembers] = await Promise.all([
    getConversationMembers(peerId),
    getGlobalRoleMembers("spec_admin"),
    getGlobalRoleMembers("deputy_spec_admin"),
    ...CHAT_ROLES.map((role) => getChatRoleMembers(peerId, role)),
  ]);

  const owner = members.find((m) => m.isOwner);
  const positiveIds = [
    ...specAdmins,
    ...deputyAdmins,
    ...chatRoleMembers.flat(),
  ];
  const infoMap = await getUsersInfo(positiveIds);
  const nameOf = (id: number) => {
    const info = infoMap.get(id);
    return profileLink(id, info ? `${info.first_name} ${info.last_name}` : `id${id}`);
  };

  const lines: string[] = [];
  lines.push(`Владелец беседы — ${owner ? await nameLinkOfAny(owner.memberId) : "Отсутствуют"}`);
  lines.push("");

  lines.push("Спец администраторы:");
  lines.push(specAdmins.length ? specAdmins.map((id) => nameOf(id)).join("\n") : "Отсутствуют");
  lines.push("");

  lines.push("Зам.Спец администратора:");
  lines.push(deputyAdmins.length ? deputyAdmins.map((id) => nameOf(id)).join("\n") : "Отсутствуют");
  lines.push("");

  const sectionLabels: Record<string, string> = {
    senior_admin: "Старшие администраторы",
    admin: "Администраторы",
    senior_moderator: "Старшие модераторы",
    moderator: "Модераторы",
  };

  CHAT_ROLES.forEach((role, i) => {
    const ids = chatRoleMembers[i];
    lines.push(`${sectionLabels[role]}:`);
    lines.push(ids.length ? ids.map((id) => nameOf(id)).join("\n") : "Отсутствуют");
    lines.push("");
  });

  return lines.join("\n").trim();
}

// --- /help: список команд, доступных пользователю по его рангу ---

interface CommandInfo {
  cmd: string;
  description: string;
  minRole: AnyRole;
}

export const COMMAND_REGISTRY: CommandInfo[] = [
  { cmd: "/stats", description: "статистика профиля", minRole: "user" },
  { cmd: "/help", description: "список доступных вам команд", minRole: "user" },
  { cmd: "/onlinelist", description: "список пользователей онлайн (/olist, «онлайн»)", minRole: "user" },

  { cmd: "/staff", description: "список рангов беседы", minRole: "moderator" },
  { cmd: "/clear", description: "удалить сообщение (ответом на него)", minRole: "moderator" },
  { cmd: "/mute", description: "замутить пользователя", minRole: "moderator" },
  { cmd: "/unmute", description: "снять мут", minRole: "moderator" },
  { cmd: "/setnick", description: "назначить ник", minRole: "moderator" },
  { cmd: "/getnick", description: "узнать ник пользователя", minRole: "moderator" },
  { cmd: "/removenick", description: "убрать ник", minRole: "moderator" },
  { cmd: "/nlist", description: "все ники в чате", minRole: "moderator" },
  { cmd: "/getacc", description: "найти профиль по нику", minRole: "moderator" },
  { cmd: "/getban", description: "блокировки пользователя", minRole: "moderator" },
  { cmd: "/kick", description: "кикнуть из беседы", minRole: "moderator" },
  { cmd: "/alt", description: "альтернативные названия команд", minRole: "moderator" },
  { cmd: "/addmoder", description: "назначить модератора", minRole: "senior_moderator" },
  { cmd: "/delmoder", description: "снять модератора", minRole: "senior_moderator" },
  { cmd: "/ban", description: "бан+кик в этой беседе", minRole: "senior_moderator" },
  { cmd: "/banlist", description: "все баны пользователя", minRole: "senior_moderator" },

  { cmd: "/timeout", description: "режим тишины в чате (альт. «тишина»)", minRole: "admin" },
  { cmd: "/skick", description: "кик из всех ваших бесед", minRole: "admin" },
  { cmd: "/addsenmoder", description: "назначить старшего модератора", minRole: "admin" },
  { cmd: "/delsenmoder", description: "снять старшего модератора", minRole: "admin" },
  { cmd: "/sban", description: "бан+кик во всех ваших беседах", minRole: "admin" },

  { cmd: "/addgroup", description: "привязать беседу к себе", minRole: "spec_admin" },
  { cmd: "/delgroup", description: "отвязать беседу", minRole: "spec_admin" },
  { cmd: "/mygroups", description: "список ваших бесед", minRole: "spec_admin" },
  { cmd: "/server", description: "привязать беседу к серверу проекта", minRole: "spec_admin" },
  { cmd: "/type", description: "выбрать тип беседы", minRole: "senior_admin" },
  { cmd: "/addadmin", description: "назначить администратора", minRole: "senior_admin" },
  { cmd: "/deladmin", description: "снять администратора", minRole: "senior_admin" },
  { cmd: "/unban", description: "снять бан в этой беседе", minRole: "senior_admin" },
  { cmd: "/sunban", description: "снять бан во всех ваших беседах", minRole: "senior_admin" },

  { cmd: "/addsenadmin", description: "назначить старшего администратора", minRole: "deputy_spec_admin" },
  { cmd: "/delsenadmin", description: "снять старшего администратора", minRole: "deputy_spec_admin" },
  { cmd: "/sync", description: "синхронизация чата с базой", minRole: "deputy_spec_admin" },
  { cmd: "/delsync", description: "удалить синхронизацию", minRole: "deputy_spec_admin" },
  { cmd: "/synclist", description: "список синхронизированных чатов", minRole: "deputy_spec_admin" },
  { cmd: "/addserver", description: "добавить сервер проекта", minRole: "deputy_spec_admin" },
  { cmd: "/delserver", description: "удалить сервер проекта", minRole: "deputy_spec_admin" },
  { cmd: "/servers", description: "список всех серверов проекта", minRole: "deputy_spec_admin" },
  { cmd: "/gban", description: "глобальный бан+кик", minRole: "deputy_spec_admin" },
  { cmd: "/gunban", description: "снять глобальный бан", minRole: "deputy_spec_admin" },
  { cmd: "/gkick", description: "кик из всех бесед бота", minRole: "deputy_spec_admin" },

  { cmd: "/addzsa", description: "назначить зам. спец. админа", minRole: "spec_admin" },
  { cmd: "/delzsa", description: "снять зам. спец. админа", minRole: "spec_admin" },

  { cmd: "/addsa", description: "назначить спец. админа", minRole: "developer" },
  { cmd: "/delsa", description: "снять спец. админа", minRole: "developer" },
  { cmd: "/resetdata", description: "полная очистка данных (только в ЛС боту)", minRole: "developer" },
];

export function buildHelpMessage(userWeight: number): string {
  const available = COMMAND_REGISTRY.filter((c) => userWeight >= ROLE_WEIGHT[c.minRole]);
  const lines = ["Доступные вам команды:"];
  for (const c of available) {
    lines.push(`${c.cmd} — ${c.description}`);
  }
  return lines.join("\n");
}

export const ALT_MAP: Record<string, string> = {
  "чистка": "/clear",
  "стафф": "/staff",
  "gnick": "/getnick",
  "никлист": "/getnick",
  "snick": "/setnick",
  "rnick": "/removenick",
  "ники": "/nlist",
  "аккаунт": "/getacc",
  "чекбан": "/getban",
  "кик": "/kick",
  "мут": "/mute",
  "заткнуть": "/mute",
  "размут": "/unmute",
  "разоткнуть": "/unmute",
  "тишина": "/timeout",
  "olist": "/onlinelist",
  "онлайн": "/onlinelist",
};
