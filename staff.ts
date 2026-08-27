import { getConversationMembers, getUsersInfo, nameLinkOfAny, profileLink } from "./vk.ts";
import { type AnyRole, CHAT_ROLES, getChatRoleMembers, getGlobalRoleMembers, getServerRoleMembers, ROLE_WEIGHT } from "./roles.ts";

export async function buildStaffMessage(peerId:number,serverName:string|null):Promise<string>{
  const [members,specAdmins,deputySpecAdmins,mainAdmins,deputyMainAdmins,...chatRoleMembers]=await Promise.all([
    getConversationMembers(peerId),getGlobalRoleMembers("spec_admin"),getGlobalRoleMembers("deputy_spec_admin"),
    serverName?getServerRoleMembers(serverName,"main_admin"):Promise.resolve([]),
    serverName?getServerRoleMembers(serverName,"deputy_main_admin"):Promise.resolve([]),
    ...CHAT_ROLES.map(role=>getChatRoleMembers(peerId,role)),
  ]);
  const owner=members.find((m:any)=>m.isOwner);const ids=[...specAdmins,...deputySpecAdmins,...mainAdmins,...deputyMainAdmins,...chatRoleMembers.flat()];const info=await getUsersInfo(ids);
  const nameOf=(id:number)=>profileLink(id,info.get(id)?`${info.get(id).first_name} ${info.get(id).last_name}`:`id${id}`);
  const section=(title:string,ids:number[],empty:string)=>`${title}:\n${ids.length?ids.map(nameOf).join("\n"):empty}`;
  const lines:string[]=[`Владелец беседы — ${owner?await nameLinkOfAny(Number(owner.memberId??owner.member_id)):"отсутствует"}`,""];
  lines.push(section("Спец администраторы",specAdmins,"Отсутствует"),"");
  lines.push(section("Зам.Спец администратора",deputySpecAdmins,"Отсутствуют"),"");
  lines.push(section("Главный администратор",mainAdmins,"Отсутствует"),"");
  lines.push(section("Зам.Главного администратора",deputyMainAdmins,"Отсутствует"),"");
  const labels:any={senior_admin:"Старшие администраторы",admin:"Администраторы",senior_moderator:"Старшие модераторы",moderator:"Модераторы"};
  const empty:any={senior_admin:"Отсутствуют",admin:"Отсутствует",senior_moderator:"Отсутствуют",moderator:"Отсутствуют"};
  CHAT_ROLES.forEach((role,i)=>{lines.push(section(labels[role],chatRoleMembers[i],empty[role]),"");});
  return lines.join("\n").trim();
}

interface CommandInfo{cmd:string;description:string;minRole:AnyRole}
export const COMMAND_REGISTRY:CommandInfo[]=[
  {cmd:"/addsa",description:"поставить спец администратора",minRole:"developer"},{cmd:"/delsa",description:"снять спец администратора",minRole:"developer"},
  {cmd:"/addserver",description:"добавить сервер",minRole:"spec_admin"},{cmd:"/delserver",description:"удалить сервер",minRole:"spec_admin"},{cmd:"/server",description:"привязать беседу к серверу",minRole:"spec_admin"},{cmd:"/servers",description:"все серверы проекта",minRole:"spec_admin"},
  {cmd:"/sync",description:"синхронизировать чат",minRole:"deputy_spec_admin"},{cmd:"/delsync",description:"удалить синхронизацию",minRole:"deputy_spec_admin"},{cmd:"/synclist",description:"все синхронизированные чаты",minRole:"deputy_spec_admin"},{cmd:"/addserverga",description:"поставить главного администратора сервера",minRole:"deputy_spec_admin"},{cmd:"/delserverga",description:"снять главного администратора сервера",minRole:"deputy_spec_admin"},{cmd:"/gban",description:"глобальная блокировка",minRole:"deputy_spec_admin"},{cmd:"/gunban",description:"снять глобальную блокировку",minRole:"deputy_spec_admin"},{cmd:"/gkick",description:"глобальный кик",minRole:"deputy_spec_admin"},
  {cmd:"/sunban",description:"снять серверный бан",minRole:"main_admin"},{cmd:"/addzga",description:"поставить зам. главного администратора",minRole:"main_admin"},{cmd:"/delzga",description:"снять зам. главного администратора",minRole:"main_admin"},
  {cmd:"/sban",description:"выдать серверный бан",minRole:"deputy_main_admin"},{cmd:"/unban",description:"снять блокировку чата",minRole:"deputy_main_admin"},{cmd:"/addsenadmin",description:"назначить старшего администратора",minRole:"deputy_main_admin"},{cmd:"/delsenadmin",description:"снять старшего администратора",minRole:"deputy_main_admin"},{cmd:"/skick",description:"кик из всех бесед сервера",minRole:"deputy_main_admin"},
  {cmd:"/ban",description:"выдать блокировку чата",minRole:"senior_admin"},{cmd:"/addadmin",description:"назначить администратора",minRole:"senior_admin"},{cmd:"/deladmin",description:"снять администратора",minRole:"senior_admin"},{cmd:"/banlist",description:"история блокировок пользователя",minRole:"senior_admin"},
  {cmd:"/addsenmoder",description:"назначить старшего модератора",minRole:"admin"},{cmd:"/delsenmoder",description:"снять старшего модератора",minRole:"admin"},{cmd:"/timeout",description:"режим тишины",minRole:"admin"},{cmd:"/olist",description:"список участников онлайн",minRole:"admin"},{cmd:"/zov",description:"вызвать пользователей",minRole:"admin"},
  {cmd:"/addmoder",description:"назначить модератора",minRole:"senior_moderator"},{cmd:"/delmoder",description:"снять модератора",minRole:"senior_moderator"},{cmd:"/mute",description:"выдать мут",minRole:"senior_moderator"},{cmd:"/unmute",description:"снять мут",minRole:"senior_moderator"},{cmd:"/clear",description:"очистить сообщения",minRole:"senior_moderator"},
  {cmd:"/setnick",description:"поставить ник",minRole:"moderator"},{cmd:"/removenick",description:"убрать ник",minRole:"moderator"},{cmd:"/getacc",description:"найти аккаунт по нику",minRole:"moderator"},{cmd:"/getnick",description:"найти ник пользователя",minRole:"moderator"},{cmd:"/alt",description:"альтернативные команды",minRole:"moderator"},{cmd:"/nlist",description:"все ники в чате",minRole:"moderator"},{cmd:"/staff",description:"список администрации",minRole:"moderator"},{cmd:"/getban",description:"активные блокировки",minRole:"moderator"},{cmd:"/kick",description:"кик из беседы",minRole:"moderator"},
  {cmd:"/stats",description:"статистика пользователя",minRole:"user"},{cmd:"/help",description:"список доступных вам команд",minRole:"user"},{cmd:"/info",description:"официальные ресурсы проекта",minRole:"user"},
];
export function buildHelpMessage(userWeight:number){const available=COMMAND_REGISTRY.filter(c=>userWeight>=ROLE_WEIGHT[c.minRole]);return ["Список доступных вам команд:","",...available.map(c=>`${c.cmd} — ${c.description}`)].join("\n");}

export const ALT_TEXT=[
  "Альтернативные команды","","Команды модераторов:",
  "/alt — альт","/clear — чистка","/staff — стафф","/getnick — gnick, никлист, гетник","/setnick — snick","/removenick — rnick","/nlist — ники","/getacc — аккаунт, гетакк","/getban — чекбан, гетбан","/kick — кик, кикнуть","/mute — мут, заткнуть","/unmute — размут, разоткнуть","/stats — стата, статс",
].join("\n");
