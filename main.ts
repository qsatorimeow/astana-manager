import { redis } from "./kv.ts";
import {
  callVkApi, isChatPeer, sendMessageAndGetIds, getConversationMembers, getUsersInfo,
  nameLinkOfAny, resolveTargetUserId, deleteMessages, kickFromChat, profileLink,
} from "./vk.ts";
import {
  addServer, removeServer, serverExists, listServers, bindChatToServer,
  getChatServer, getServerChats,
} from "./servers.ts";
import {
  resolveUserRole, hasAtLeastRole, ROLE_LABEL, ROLE_WEIGHT, ROLE_GENITIVE,
  addGlobalRole, removeGlobalRole, addServerRole, removeServerRole,
  addChatRole, removeChatRole, isDeveloperId,
  type AnyRole, type GlobalRole, type ServerRole, type ChatRole,
} from "./roles.ts";
import { syncChat, clearSync, isSynced, getSyncRecord, buildSyncListMessage, isChatConfigured } from "./setup.ts";
import {
  setChatBan, clearChatBan, getChatBan, setServerBan, clearServerBan, setGlobalBan, clearGlobalBan,
  getGlobalBan, getAllServerBans, logBanEvent, getBanHistory, kickFromServerChats, kickFromAllSyncedChats,
  setMute, clearMute, isTimeoutActive, setTimeoutMode,
} from "./moderation.ts";
import { setNickFor, removeNickFor, getNickFor, findUserIdByNick, listNicks } from "./nicknames.ts";
import { buildStaffMessage, buildHelpMessage, ALT_TEXT } from "./staff.ts";

const DEV = new Set((Deno.env.get("DEVELOPER_IDS") ?? "").split(",").map(x => Number(x.trim())).filter(Boolean));
const P = "b2:";
const key = (...parts: (string|number)[]) => P + parts.join(":");
const MOSCOW = "Europe/Moscow";

function nowText(ts=Date.now()) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }).format(new Date(ts)).replace(/(\d+)\.(\d+)\.(\d+),/, "$3-$2-$1").replace(/,/g,"") + " МСК (UTC+3)";
}
function firstName(u:any){ return u ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() : "Пользователь"; }
async function actorName(id:number){ const m=await getUsersInfo([id]); return firstName(m.get(id)) || `id${id}`; }
async function userLink(id:number){ return nameLinkOfAny(id); }
async function can(peer:number,user:number,min:AnyRole){ if(DEV.has(user)||isDeveloperId(user)) return true; return hasAtLeastRole(peer,user,await getChatServer(peer),min); }
async function configured(peer:number){ return isChatConfigured(peer); }

async function reply(peer:number,m:any,text:string,keyboard?:any){
  const cmid=Number(m?.conversation_message_id??0)||undefined;
  console.log(`[REPLY] peer=${peer} cmid=${cmid??"none"}`);
  return sendMessageAndGetIds(peer,text,{replyTo:cmid,keyboard});
}
function argText(args:string[]){ return args.join(" ").trim(); }

async function targetFromMessage(m:any,args:string[]):Promise<{id:number|null; consumed:number}> {
  const rm=m?.reply_message ?? m?.reply_message?.message;
  const replyId=Number(rm?.from_id??0);
  if(replyId>0) return {id:replyId,consumed:0};
  const first=args[0] ?? "";
  const id=await resolveTargetUserId(first);
  if(id) return {id,consumed:1};
  return {id:null,consumed:0};
}
async function actionRole(peer:number,target:number,role:ChatRole|ServerRole|GlobalRole,adding:boolean,scope:"chat"|"server"|"global"){
  if(scope==="chat") adding ? await addChatRole(peer,role as ChatRole,target) : await removeChatRole(peer,role as ChatRole,target);
  else if(scope==="server") { const s=await getChatServer(peer); if(!s) return false; adding ? await addServerRole(s,role as ServerRole,target) : await removeServerRole(s,role as ServerRole,target); }
  else adding ? await addGlobalRole(role as GlobalRole,target) : await removeGlobalRole(role as GlobalRole,target);
  return true;
}
async function moderationRecord(peer:number,actor:number,reason:string){ const r=await resolveUserRole(peer,actor,await getChatServer(peer)); return {reason,byUserId:actor,byWeight:r.weight,at:Date.now(),label:(await getChatServer(peer))??String(peer)}; }
async function banAction(peer:number,actor:number,target:number,type:"ban"|"unban"|"sban"|"sunban"|"gban"|"gunban",reason:string){
  const rec=await moderationRecord(peer,actor,reason); const server=await getChatServer(peer);
  if(type==="ban") await setChatBan(peer,target,rec); if(type==="unban") await clearChatBan(peer,target);
  if(type==="sban" && server) await setServerBan(server,target,rec); if(type==="sunban" && server) await clearServerBan(server,target);
  if(type==="gban") await setGlobalBan(target,rec); if(type==="gunban") await clearGlobalBan(target);
  await logBanEvent(target,{...rec,type,peerId:peer});
}

const commandAliases:Record<string,string> = {
  "/альт":"/alt","/чистка":"/clear","/стафф":"/staff","/gnick":"/getnick","/никлист":"/getnick","/гетник":"/getnick",
  "/snick":"/setnick","/rnick":"/removenick","/ники":"/nlist","/аккаунт":"/getacc","/гетакк":"/getacc",
  "/чекбан":"/getban","/гетбан":"/getban","/кик":"/kick","/кикнуть":"/kick","/мут":"/mute","/заткнуть":"/mute",
  "/размут":"/unmute","/разоткнуть":"/unmute","/стата":"/stats","/статс":"/stats","/тишина":"/timeout",
};

async function handleCommand(m:any){
  if(!m || typeof m!=="object") return;
  const peer=Number(m.peer_id??0), user=Number(m.from_id??m.user_id??0), text=String(m.text??"").trim();
  if(user<=0) return;
  const [raw,...args0]=text.split(/\s+/); let cmd=String(raw??"").toLowerCase(); cmd=commandAliases[cmd]??cmd;
  console.log(`[MESSAGE RAW] peer_id=${m.peer_id??"missing"} from_id=${m.from_id??"missing"} cmid=${m.conversation_message_id??"missing"} text=${JSON.stringify(text)}`);

  // Полный сброс — только разработчик и только ЛС. В беседах команда игнорируется.
  if(!isChatPeer(peer)){
    if(cmd!=="/resetdata" || !DEV.has(user)) return;
    await redis.flushdb();
    return reply(peer,m,"Все данные бота полностью сброшены. База данных очищена.");
  }
  if(cmd==="/resetdata") return;

  // Эти команды работают до полной настройки беседы.
  if(cmd==="/sync"){
    if(!await can(peer,user,"deputy_spec_admin")) return reply(peer,m,"Недостаточно прав.");
    await syncChat(peer,user); return reply(peer,m,"Синхронизация с базой данных прошла успешно!");
  }
  if(cmd==="/delsync"){
    if(!await can(peer,user,"deputy_spec_admin")) return reply(peer,m,"Недостаточно прав.");
    await clearSync(peer); return reply(peer,m,"Синхронизация с базой данных удалена.");
  }
  if(cmd==="/synclist"){
    if(!await can(peer,user,"deputy_spec_admin")) return reply(peer,m,"Недостаточно прав.");
    return reply(peer,m,await buildSyncListMessage());
  }
  if(cmd==="/addserver"){
    if(!await can(peer,user,"spec_admin")) return reply(peer,m,"Недостаточно прав.");
    const name=argText(args0); if(!name) return reply(peer,m,"Вы не указали название сервера");
    if(!(await addServer(name))) return reply(peer,m,"Данный сервер уже существует");
    return reply(peer,m,`Сервер <<${name}>> добавлен в список серверов проекта`);
  }
  if(cmd==="/delserver"){
    if(!await can(peer,user,"spec_admin")) return reply(peer,m,"Недостаточно прав.");
    const name=argText(args0); if(!name) return reply(peer,m,"Вы не указали название сервера");
    await removeServer(name); return reply(peer,m,`Сервер <<${name}>> удален из списков серверов проекта`);
  }
  if(cmd==="/server"){
    if(!await can(peer,user,"spec_admin")) return reply(peer,m,"Недостаточно прав.");
    if(!(await isSynced(peer))) return reply(peer,m,"Сначала выполните /sync");
    const name=argText(args0); if(!name) return reply(peer,m,"Вы не указали название сервера");
    if(!(await serverExists(name))) return reply(peer,m,"Данного сервера не существует");
    await bindChatToServer(peer,name); return reply(peer,m,`Вы привязали данную беседу в список бесед сервера <<${name}>>`);
  }
  if(cmd==="/servers"){
    if(!await can(peer,user,"spec_admin")) return reply(peer,m,"Недостаточно прав.");
    const lines=["Список всех серверов проекта:",""];
    for(const name of await listServers()){
      const roleMod=await import("./roles.ts"); const mains=await roleMod.getServerRoleMembers(name,"main_admin");
      const mainLink=mains[0]?await userLink(mains[0]):"отсутствует";
      lines.push(`Сервер <<${name}>>, Главный администратор — ${mainLink}`);
      for(const p of await getServerChats(name)){const r=await getSyncRecord(p);lines.push(`"${r?.chatName??p}" | ${r?.ownerId?await userLink(r.ownerId):"неизвестно"} | ${p}`)}
      lines.push("");
    }
    return reply(peer,m,lines.join("\n").trim()||"Список серверов проекта пуст.");
  }

  if(!(await configured(peer))){ console.log(`[COMMAND IGNORE] peer=${peer} cmd=${cmd} reason=chat_not_configured`); return; }
  const server=await getChatServer(peer); const actorRole=await resolveUserRole(peer,user,server);

  if(cmd==="/help") return reply(peer,m,buildHelpMessage(actorRole.weight));
  if(cmd==="/info") return reply(peer,m,["Официальные ресурсы проекта:","Разработчик — https://vk.com/id1104716287","Тех поддержка — https://vk.com/id1104716287","Начать сотрудничество — https://vk.ru/id1104716287","Спец администратор — https://vk.ru/id1104716287"].join("\n"));
  if(cmd==="/staff"){if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав.");return reply(peer,m,await buildStaffMessage(peer,server));}
  if(cmd==="/alt"){if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав.");return reply(peer,m,ALT_TEXT);}
  if(cmd==="/stats"){
    const target=(await targetFromMessage(m,args0)).id??user; const info=(await getUsersInfo([target])).get(target); const r=await resolveUserRole(peer,target,server);
    const nick=await getNickFor(peer,target); const count=Number(await redis.get(key("messages",peer,target))??0); const last=Number(await redis.get(key("last",peer,target))??0);
    return reply(peer,m,`Информация о пользователе ${profileLink(target,firstName(info)||`id${target}`)}\nРоль: ${ROLE_LABEL[r.role]}\nНик: ${nick??"Нет"}\nВсего сообщений: ${count}\nПоследнее сообщение: ${last?nowText(last):"Нет"}`);
  }
  if(cmd==="/getnick"){
    if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя");
    return reply(peer,m,`Ник пользователя — ${await getNickFor(peer,t.id)??"Нет"}`);
  }
  if(cmd==="/setnick"){
    if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя"); const nick=args0.slice(t.consumed).join(" ").trim(); if(!nick)return reply(peer,m,"Вы не указали ник");
    const tr=await resolveUserRole(peer,t.id,server); if(tr.weight>=actorRole.weight&&!DEV.has(user))return reply(peer,m,"Вы не можете менять ник данному пользователю!");
    await setNickFor(peer,t.id,nick); return reply(peer,m,`${await actorName(user)} сменил-(а) ник у ${await actorName(t.id)}\nНовый ник: ${nick}`);
  }
  if(cmd==="/removenick"){
    if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя"); const tr=await resolveUserRole(peer,t.id,server); if(tr.weight>=actorRole.weight&&!DEV.has(user))return reply(peer,m,"Вы не можете снять ник данного пользователя!"); if(!(await getNickFor(peer,t.id)))return reply(peer,m,"У Пользователя нет ника");
    await removeNickFor(peer,t.id); return reply(peer,m,`${await actorName(user)} убрал-(а) ник у ${await actorName(t.id)}`);
  }
  if(cmd==="/getacc"){
    if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав."); const nick=args0.join(" ").trim(); if(!nick)return reply(peer,m,"Вы не указали ник"); const id=await findUserIdByNick(peer,nick); if(!id)return reply(peer,m,"Пользователь с таким ником не найден"); return reply(peer,m,`Ник ${nick} принадлежит — ${await userLink(id)}`);
  }
  if(cmd==="/nlist"){
    if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав.");
    const rows=await listNicks(peer), page=rows.slice(0,50), lines=["Пользователи с ником [1 страница]:"];
    for(let i=0;i<page.length;i++) lines.push(`${i+1}) ${await actorName(page[i].userId)} — ${page[i].nick}`);
    if(!page.length) lines.push("Отсутствуют"); return reply(peer,m,lines.join("\n"));
  }
  if(cmd==="/getban"){
    if(!await can(peer,user,"moderator"))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя");
    const gb=await getGlobalBan(t.id), sb=await getAllServerBans(t.id), cb=await getChatBan(peer,t.id); const l=[`Информация о блокировках ${await actorName(t.id)}`,"",`Глобальная блокировка — ${gb?"Да":"Нет"}`];
    if(gb)l.push(`${await userLink(gb.byUserId)} | ${gb.reason} | ${nowText(gb.at)}`); l.push("", "Блокировки в беседах серверов —");
    if(sb.length)for(const x of sb)l.push(`Блокировка сервера <<${x.serverName}>> | ${await userLink(x.record.byUserId)} | ${x.record.reason} | ${nowText(x.record.at)}`); else l.push("Отсутствуют");
    l.push("", "Блокировка в этой беседе —"); if(cb)l.push(`${await userLink(cb.byUserId)} | ${cb.reason} | ${nowText(cb.at)}`); else l.push("Отсутствует"); return reply(peer,m,l.join("\n"));
  }
  if(cmd==="/banlist"){
    if(!await can(peer,user,"senior_admin"))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя"); const hist=await getBanHistory(t.id);
    const l=[`Список блокировок пользователя ${await userLink(t.id)}:`,"","Пример: самые новые сверху"]; for(const h of hist)l.push(`${h.type} | ${h.label??""} | ${await userLink(h.byUserId)} | ${h.reason} | ${nowText(h.at)}`); return reply(peer,m,l.join("\n"));
  }

  const roleCommands:[string,ChatRole,AnyRole,boolean][]=[
    ["/addmoder","moderator","senior_moderator",true],["/delmoder","moderator","senior_moderator",false],
    ["/addsenmoder","senior_moderator","admin",true],["/delsenmoder","senior_moderator","admin",false],
    ["/addadmin","admin","senior_admin",true],["/deladmin","admin","senior_admin",false],
    ["/addsenadmin","senior_admin","deputy_main_admin",true],["/delsenadmin","senior_admin","deputy_main_admin",false],
  ];
  const rc=roleCommands.find(x=>x[0]===cmd);
  if(rc){
    if(!await can(peer,user,rc[2]))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя");
    const tr=await resolveUserRole(peer,t.id,server); if(tr.weight>=actorRole.weight&&!DEV.has(user))return reply(peer,m,"Вы не можете изменить права данного пользователя!");
    await actionRole(peer,t.id,rc[1],rc[3],"chat"); const verb=rc[3]?"выдал-(а) права":"забрал-(а) права"; return reply(peer,m,`${await actorName(user)} ${verb} ${ROLE_GENITIVE[rc[1]]} ${await actorName(t.id)}`);
  }

  const globalRoleCmd:{cmd:string;role:GlobalRole;add:boolean;min:AnyRole}[]=[
    {cmd:"/addsa",role:"spec_admin",add:true,min:"developer"},{cmd:"/delsa",role:"spec_admin",add:false,min:"developer"},
  ];
  const gr=globalRoleCmd.find(x=>x.cmd===cmd);
  if(gr){if(!await can(peer,user,gr.min))return reply(peer,m,"Недостаточно прав.");const t=await targetFromMessage(m,args0);if(!t.id)return reply(peer,m,"Вы не указали пользователя");await actionRole(peer,t.id,gr.role,gr.add,"global");return reply(peer,m,`${await actorName(user)} ${gr.add?"выдал-(а) права":"забрал-(а) права"} ${ROLE_GENITIVE[gr.role]} ${await actorName(t.id)}`);}

  const serverRoleCmd:{cmd:string;role:ServerRole;add:boolean;min:AnyRole}[]=[
    {cmd:"/addserverga",role:"main_admin",add:true,min:"deputy_spec_admin"},{cmd:"/delserverga",role:"main_admin",add:false,min:"deputy_spec_admin"},
    {cmd:"/addzga",role:"deputy_main_admin",add:true,min:"main_admin"},{cmd:"/delzga",role:"deputy_main_admin",add:false,min:"main_admin"},
  ];
  const sr=serverRoleCmd.find(x=>x.cmd===cmd);
  if(sr){if(!server)return reply(peer,m,"Беседа не привязана к серверу.");if(!await can(peer,user,sr.min))return reply(peer,m,"Недостаточно прав.");const t=await targetFromMessage(m,args0);if(!t.id)return reply(peer,m,"Вы не указали пользователя");await actionRole(peer,t.id,sr.role,sr.add,"server");return reply(peer,m,`${await actorName(user)} ${sr.add?"выдал-(а) права":"забрал-(а) права"} ${ROLE_GENITIVE[sr.role]} ${await actorName(t.id)}`);}

  const banCmds:[string,AnyRole,"ban"|"unban"|"sban"|"sunban"|"gban"|"gunban"][]=[
    ["/ban","senior_admin","ban"],["/unban","deputy_main_admin","unban"],["/sban","deputy_main_admin","sban"],["/sunban","main_admin","sunban"],["/gban","deputy_spec_admin","gban"],["/gunban","deputy_spec_admin","gunban"],
  ];
  const bc=banCmds.find(x=>x[0]===cmd);
  if(bc){
    if(!await can(peer,user,bc[1]))return reply(peer,m,"Недостаточно прав."); const t=await targetFromMessage(m,args0); if(!t.id)return reply(peer,m,"Вы не указали пользователя"); const reason=argText(args0.slice(t.consumed)); if(!reason)return reply(peer,m,"Вы не указали причину");
    await banAction(peer,user,t.id,bc[2],reason); const scope=bc[2]==="gban"||bc[2]==="gunban"?"во всех беседах проекта":bc[2]==="sban"||bc[2]==="sunban"?`во всех беседах сервера <<${server}>>`:""; const verb=["unban","sunban","gunban"].includes(bc[2])?"разблокировал-(а)":"заблокировал-(а)";
    return reply(peer,m,`${await actorName(user)} ${verb} ${scope} ${await actorName(t.id)}\nПричина: ${reason}`);
  }

  if(cmd==="/kick"||cmd==="/skick"||cmd==="/gkick"){
    const min:AnyRole=cmd==="/kick"?"moderator":cmd==="/skick"?"deputy_main_admin":"deputy_spec_admin"; if(!await can(peer,user,min))return reply(peer,m,"Недостаточно прав.");
    const t=await targetFromMessage(m,args0);if(!t.id)return reply(peer,m,"Вы не указали пользователя");const reason=argText(args0.slice(t.consumed));if(!reason)return reply(peer,m,"Вы не указали причину");let scope="";
    if(cmd==="/kick"){await kickFromChat(peer,t.id);scope="из беседы"} else if(cmd==="/skick"){await kickFromServerChats(server!,t.id);scope=`из всех бесед сервера <<${server}>>`} else {await kickFromAllSyncedChats(t.id);scope="из всех бесед проекта"}
    return reply(peer,m,`${await actorName(user)} исключил-(а) ${scope} ${await actorName(t.id)}\nПричина: ${reason}`);
  }

  if(cmd==="/mute"){
    if(!await can(peer,user,"senior_moderator"))return reply(peer,m,"Недостаточно прав.");const t=await targetFromMessage(m,args0);if(!t.id)return reply(peer,m,"Вы не указали пользователя");const rest=args0.slice(t.consumed);const minutes=Number(rest[0]);if(!Number.isFinite(minutes)||minutes<=0)return reply(peer,m,"Вы не указали время мута");const reason=rest.slice(1).join(" ").trim();if(!reason)return reply(peer,m,"Вы не указали причину");
    const targetCmid=Number(m?.reply_message?.conversation_message_id??0)||undefined;const expires=Date.now()+minutes*60000;await setMute(peer,t.id,{reason,byUserId:user,expiresAt:expires,moderatorCmid:Number(m.conversation_message_id)||undefined,targetCmid});
    return reply(peer,m,`${await actorName(user)} замьютил-(а) ${await actorName(t.id)}\nПричина: ${reason}\nМут выдан до: ${nowText(expires)}`);
  }
  if(cmd==="/unmute"){
    if(!await can(peer,user,"senior_moderator"))return reply(peer,m,"Недостаточно прав.");const t=await targetFromMessage(m,args0);if(!t.id)return reply(peer,m,"Вы не указали пользователя");const reason=argText(args0.slice(t.consumed));if(!reason)return reply(peer,m,"Вы не указали причину");await clearMute(peer,t.id);return reply(peer,m,`${await actorName(user)} размьютил-(а) ${await actorName(t.id)}\nПричина: ${reason}`);
  }
  if(cmd==="/clear"){
    if(!await can(peer,user,"senior_moderator"))return reply(peer,m,"Недостаточно прав.");const targetCmid=Number(m?.reply_message?.conversation_message_id??0)||0;if(!targetCmid)return reply(peer,m,"Вы должны ответить на сообщение пользователя");const targetId=Number(m?.reply_message?.from_id??0);if(!targetId)return reply(peer,m,"Не удалось определить пользователя сообщения");const tr=await resolveUserRole(peer,targetId,server);if(tr.weight>=actorRole.weight&&!DEV.has(user))return reply(peer,m,"Вы не можете очистить сообщения данного пользователя!");await deleteMessages(peer,[targetCmid,Number(m.conversation_message_id)||0]);return reply(peer,m,`${await actorName(user)} очистил-(а) сообщение-(я)!`);
  }
  if(cmd==="/timeout"){
    if(!await can(peer,user,"admin"))return reply(peer,m,"Недостаточно прав.");const on=!(await isTimeoutActive(peer));await setTimeoutMode(peer,on);return reply(peer,m,`${await actorName(user)} ${on?"включил-(а)":"выключил-(а)"} режим тишины`);
  }
  if(cmd==="/olist"){
    if(!await can(peer,user,"admin"))return reply(peer,m,"Недостаточно прав.");const members=await getConversationMembers(peer);const online=members.filter((x:any)=>Boolean(x.isOnline??x.is_online)).map((x:any)=>Number(x.memberId??x.member_id)).filter(Boolean);const names=await getUsersInfo(online);const lines=[`${await actorName(user)}, список пользователей онлайн`,""];for(const id of online)lines.push(profileLink(id,firstName(names.get(id))));lines.push(`Всего в онлайн: ${online.length}`);return reply(peer,m,lines.join("\n"));
  }
  if(cmd==="/zov"){
    if(!await can(peer,user,"admin"))return reply(peer,m,"Недостаточно прав.");const reason=argText(args0);if(!reason)return reply(peer,m,"Вы не указали причину");const members=await getConversationMembers(peer);const staffIds=new Set<number>();const roleMod=await import("./roles.ts");for(const r of ["senior_admin","admin","senior_moderator","moderator"] as ChatRole[])for(const id of await roleMod.getChatRoleMembers(peer,r))staffIds.add(id);const tags=members.map((x:any)=>Number(x.memberId??x.member_id)).filter((id:number)=>id>0&&!staffIds.has(id)).map((id:number)=>`[id${id}|🖤]`).join(" ");return reply(peer,m,`🔔 Вы были вызваны администратором беседы\n\n${tags}\n\n❗ Причина вызова: ${reason}`);
  }

  console.log(`[COMMAND UNHANDLED] peer=${peer} cmd=${cmd}`);
}

Deno.serve(async(req)=>{
  try{
    if(req.method!=="POST") return new Response("ok");
    const body=await req.json();console.log(`[WEBHOOK] type=${body?.type??"?"}`);
    if(body?.type==="confirmation") return new Response(Deno.env.get("VK_CONFIRMATION")??"");
    const expected=Deno.env.get("VK_SECRET"),received=body?.secret;
    if(expected&&received&&expected!==received)return new Response("bad",{status:403});
    if(expected&&!received)console.warn(`[WEBHOOK] VK_SECRET is set, but VK callback contains no secret; processing event anyway`);
    if(body?.type!=="message_new")return new Response("ok");
    let obj=body.object;if(typeof obj==="string"){try{obj=JSON.parse(obj)}catch{console.error("[WEBHOOK] object JSON parse failed");return new Response("ok")}}
    const m=obj?.message??obj?.object?.message??obj?.object??obj;if(m)await handleCommand(m);return new Response("ok");
  }catch(e){console.error("[WEBHOOK ERROR]",e);return new Response("ok")}
});
