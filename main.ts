import { callVkApi, deleteMessages, getConversationMembers, getUsersInfo, isChatPeer, kickFromChat, nameLinkOf, profileLink, resolveTargetUserId, sendMessageAndGetIds } from "./vk.ts";
import { redis } from "./kv.ts";
import * as Setup from "./setup.ts";
import * as Roles from "./roles.ts";
import * as Servers from "./servers.ts";
import * as Mod from "./moderation.ts";
import * as Nick from "./nicknames.ts";
import * as Activity from "./activity.ts";
import { buildStaffMessage, buildHelpMessage, ALT_TEXT, ALT_MAP } from "./staff.ts";

const DEV = new Set((Deno.env.get("DEVELOPER_IDS") ?? "").split(",").map(x=>Number(x.trim())).filter(Boolean));
const ROLE = Roles.ROLE_WEIGHT;
const now = () => Date.now();
const fmt = (ms:number|null|undefined) => ms ? new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(ms)).replace(","," ")+" МСК (UTC+3)" : "Нет";
const cmdOf=(s:string)=>s.trim().split(/\s+/)[0]?.toLowerCase()??"";
const argsOf=(s:string)=>s.trim().split(/\s+/).slice(1);
const reasonFrom=(a:string[])=>a.join(" ").trim();
const label=(r:Roles.AnyRole)=>Roles.ROLE_LABEL[r];

async function roleOf(peer:number,user:number){return Roles.resolveUserRole(peer,user,await Servers.getChatServer(peer));}
async function can(peer:number,user:number,min:Roles.AnyRole){return (await roleOf(peer,user)).weight>=ROLE[min];}
async function reply(peer:number,m:any,text:string,keyboard?:string){return sendMessageAndGetIds(peer,text,{keyboard,replyToConversationMessageId:Number(m.conversation_message_id)||undefined});}
async function targetId(m:any,args:string[],required=true){const rm=m.reply_message; if(rm?.from_id)return Number(rm.from_id); if(args[0])return resolveTargetUserId(args[0]); if(required)return null; return Number(m.from_id);}
async function targetName(id:number){return nameLinkOf(id);}
async function protectedTarget(peer:number,actor:number,target:number){if(target<=0)return false;if(target===actor)return false;const a=(await roleOf(peer,actor)).weight,t=(await roleOf(peer,target)).weight;return t>=a;}
async function denyTarget(peer:number,m:any){return reply(peer,m,"Вы не можете выполнить это действие над данным пользователем!");}
async function requireReason(peer:number,m:any,a:string[]){if(!a.length)return reply(peer,m,"Вы не указали причину");return null;}

async function assign(peer:number,m:any,user:number,role:Roles.AnyRole,permission:Roles.AnyRole,server:boolean=false){
 if(!await can(peer,Number(m.from_id),permission))return reply(peer,m,"Недостаточно прав.");
 const target=await targetId(m,user===Number(m.from_id)?[]:[],true); return target;
}
async function setRoleCommand(peer:number,m:any,args:string[],kind:"global"|"server"|"chat",role:any,permission:Roles.AnyRole,add:boolean){
 const actor=Number(m.from_id);if(!await can(peer,actor,permission))return reply(peer,m,"Недостаточно прав.");
 const target=await targetId(m,args,true);if(!target)return reply(peer,m,"Вы не указали пользователя");
 if(target===actor||await protectedTarget(peer,actor,target))return denyTarget(peer,m);
 const server=await Servers.getChatServer(peer);
 if(kind==="global"){add?await Roles.addGlobalRole(role,target):await Roles.removeGlobalRole(role,target)}
 else if(kind==="server"){if(!server)return reply(peer,m,"Беседа не привязана к серверу.");add?await Roles.addServerRole(server,role,target):await Roles.removeServerRole(server,role,target)}
 else add?await Roles.addChatRole(peer,role,target):await Roles.removeChatRole(peer,role,target);
 const actorName=await nameLinkOf(actor), targetName_=await nameLinkOf(target), verb=add?"выдал-(а) права":"забрал-(а) права";
 return reply(peer,m,`${actorName} ${verb} ${Roles.ROLE_GENITIVE[role]} ${targetName_}`);
}

async function handleMessage(m:any){
 const peer=Number(m.peer_id), actor=Number(m.from_id), text=String(m.text??"").trim();
 if(!isChatPeer(peer)||actor<=0)return;
 const c=cmdOf(text), args=argsOf(text);
 console.log(`[MESSAGE] peer=${peer} user=${actor} cmid=${m.conversation_message_id??"-"} command=${c||"-"}`);

 // Синхронизация и /server — единственные команды настройки. ЛС намеренно не обрабатываются.
 if(c==="/sync"){
  if(!await can(peer,actor,"deputy_spec_admin"))return reply(peer,m,"Недостаточно прав.");
  const x=await Setup.syncChat(peer,actor);return reply(peer,m,"Синхронизация с базой данных прошла успешно!");
 }
 if(c==="/delsync"){
  if(!await can(peer,actor,"deputy_spec_admin"))return reply(peer,m,"Недостаточно прав.");
  await Setup.clearSync(peer);return reply(peer,m,"Синхронизация с базой данных удалена.");
 }
 if(c==="/synclist"){
  if(!await can(peer,actor,"deputy_spec_admin"))return reply(peer,m,"Недостаточно прав.");
  return reply(peer,m,await Setup.buildSyncListMessage());
 }
 if(c==="/addserver"){
  if(!await can(peer,actor,"spec_admin"))return reply(peer,m,"Недостаточно прав.");
  if(!args.length)return reply(peer,m,"Вы не указали название сервера");
  const ok=await Servers.addServer(args.join(" "));return reply(peer,m,ok?`Сервер <<${args.join(" ")}>> добавлен в список серверов проекта`:`Сервер <<${args.join(" ")}>> уже существует`);
 }
 if(c==="/delserver"){
  if(!await can(peer,actor,"spec_admin"))return reply(peer,m,"Недостаточно прав.");if(!args.length)return reply(peer,m,"Вы не указали название сервера");
  await Servers.removeServer(args.join(" "));return reply(peer,m,`Сервер <<${args.join(" ")}>> удален из списков серверов проекта`);
 }
 if(c==="/server"){
  if(!await can(peer,actor,"spec_admin"))return reply(peer,m,"Недостаточно прав.");if(!await Setup.isSynced(peer))return reply(peer,m,"Сначала выполните /sync");if(!args.length)return reply(peer,m,"Вы не указали название сервера");
  const n=args.join(" ");if(!await Servers.serverExists(n))return reply(peer,m,"Данного сервера не существует");await Servers.bindChatToServer(peer,n);return reply(peer,m,`Вы привязали данную беседу в список бесед сервера <<${n}>>`);
 }
 if(c==="/servers"){
  if(!await can(peer,actor,"spec_admin"))return reply(peer,m,"Недостаточно прав.");const lines=["Список всех серверов проекта:",""];
  for(const s of await Servers.listServers()){const ga=(await Roles.getServerRoleMembers(s,"main_admin"))[0];lines.push(`Сервер <<${s}>>, ${ga?`Главный администратор ${await nameLinkOf(ga)}`:"Главный администратор — отсутствует"}`);for(const p of await Servers.getServerChats(s)){const r=await Setup.getSyncRecord(p);lines.push(`"${r?.chatName??`Беседа ${p}`}" | ${r?.ownerId?await nameLinkOf(r.ownerId):"неизвестно"} | ${p}`)}lines.push("")}
  return reply(peer,m,lines.join("\n").trim());
 }
 if(c==="/addserverga")return setRoleCommand(peer,m,args,"server","main_admin","deputy_spec_admin",true);
 if(c==="/delserverga")return setRoleCommand(peer,m,args,"server","main_admin","deputy_spec_admin",false);
 if(c==="/addzga")return setRoleCommand(peer,m,args,"server","deputy_main_admin","main_admin",true);
 if(c==="/delzga")return setRoleCommand(peer,m,args,"server","deputy_main_admin","main_admin",false);
 if(c==="/addzsa")return setRoleCommand(peer,m,args,"global","deputy_spec_admin","spec_admin",true);
 if(c==="/delzsa")return setRoleCommand(peer,m,args,"global","deputy_spec_admin","spec_admin",false);
 if(c==="/addsa")return setRoleCommand(peer,m,args,"global","spec_admin","developer",true);
 if(c==="/delsa")return setRoleCommand(peer,m,args,"global","spec_admin","developer",false);
 if(c==="/addsenadmin")return setRoleCommand(peer,m,args,"chat","senior_admin","deputy_main_admin",true);
 if(c==="/delsenadmin")return setRoleCommand(peer,m,args,"chat","senior_admin","deputy_main_admin",false);
 if(c==="/addadmin")return setRoleCommand(peer,m,args,"chat","admin","senior_admin",true);
 if(c==="/deladmin")return setRoleCommand(peer,m,args,"chat","admin","senior_admin",false);
 if(c==="/addsenmoder")return setRoleCommand(peer,m,args,"chat","senior_moderator","admin",true);
 if(c==="/delsenmoder")return setRoleCommand(peer,m,args,"chat","senior_moderator","admin",false);
 if(c==="/addmoder")return setRoleCommand(peer,m,args,"chat","moderator","senior_moderator",true);
 if(c==="/delmoder")return setRoleCommand(peer,m,args,"chat","moderator","senior_moderator",false);

 if(!await Setup.isChatConfigured(peer)){if(c)return reply(peer,m,await Setup.getConfigStatusMessage(peer));return;}
 const server=await Servers.getChatServer(peer), rr=await roleOf(peer,actor);
 await Activity.trackMessage(peer,actor);
 const active=await Mod.getActiveBanForChat(peer,actor);if(active){await deleteMessages(peer,[Number(m.id)]);return;}
 if(await Mod.isMuted(peer,actor)){await deleteMessages(peer,[Number(m.id)]);return;}
 if(await Mod.isTimeoutActive(peer)&&rr.weight<ROLE.admin){await deleteMessages(peer,[Number(m.id)]);return;}
 if(await Mod.trackFloodAndShouldKick(peer,actor,text)){await deleteMessages(peer,[Number(m.id)]);await kickFromChat(peer,actor);return;}

 if(!c)return;
 if(c==="/stats"){
  const target=await targetId(m,args,false), r=await roleOf(peer,target), nick=await Nick.getNickFor(peer,target), st=await Activity.getMessageStats(peer,target), ban=await Mod.getChatBan(peer,target);
  return reply(peer,m,`Информация о пользователе ${await nameLinkOf(target)}\nРоль: ${label(r.role)}\nБлокировок: ${(await Mod.getBanHistory(target)).length} (все)\nБлокировка чата: ${ban?"Да":"Нет"}\nНик: ${nick??"Нет"}\nВсего сообщений: ${st.count}\nПоследнее сообщение: ${fmt(st.lastMessageMs)}`);
 }
 if(c==="/help")return reply(peer,m,buildHelpMessage(rr.weight));
 if(c==="/info")return reply(peer,m,"Официальные ресурсы проекта:\nРазработчик — https://vk.com/id1104716287\nТех поддержка — https://vk.com/id1104716287\nНачать сотрудничество — https://vk.ru/id1104716287\nСпец администратор — https://vk.ru/id1104716287");
 if(c==="/staff"){if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");return reply(peer,m,await buildStaffMessage(peer,server));}
 if(c==="/alt"){if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");return reply(peer,m,ALT_TEXT);}
 if(c==="/getnick"){if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,false);const n=await Nick.getNickFor(peer,t);return reply(peer,m,`Ник пользователя — ${n??"Нет"}`);}
 if(c==="/getacc"){if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");if(!args.length)return reply(peer,m,"Вы не указали ник");const id=await Nick.findUserIdByNick(peer,args.join(" "));return reply(peer,m,id?`Ник ${args.join(" ")} принадлежит — ${await nameLinkOf(id)}`:`Ник ${args.join(" ")} не найден`);}
 if(c==="/setnick"||c==="/removenick"){
  if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,c==="/setnick"?args:args,false);if(!t)return reply(peer,m,"Вы не указали пользователя");if(await protectedTarget(peer,actor,t))return denyTarget(peer,m);
  if(c==="/setnick"){if(!args.length&&!m.reply_message)return reply(peer,m,"Вы не указали ник");const nick=m.reply_message?args.join(" "):args.slice(1).join(" ");if(!nick)return reply(peer,m,"Вы не указали ник");await Nick.setNickFor(peer,t,nick);return reply(peer,m,`${await nameLinkOf(actor)} сменил-(а) ник у ${await nameLinkOf(t)}\nНовый ник: ${nick}`)}
  const old=await Nick.getNickFor(peer,t);if(!old)return reply(peer,m,"У Пользователя нет ника");await Nick.removeNickFor(peer,t);return reply(peer,m,`${await nameLinkOf(actor)} убрал-(а) ник у ${await nameLinkOf(t)}`);
 }
 if(c==="/nlist"){if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");const rows=await Nick.listNicks(peer), info=await getUsersInfo(rows.map(x=>x.userId));return reply(peer,m,"Пользователи с ником:\n"+(rows.length?rows.map((x,i)=>`${i+1}) ${profileLink(x.userId,`${info.get(x.userId)?.first_name??"id"} ${info.get(x.userId)?.last_name??x.userId}`)} — ${x.nick}`).join("\n"):"Отсутствуют"));}
 if(c==="/getban"){
  if(!await can(peer,actor,"moderator"))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,false);const g=await Mod.getGlobalBan(t),sb=server?await Mod.getServerBan(server,t):null,cb=await Mod.getChatBan(peer,t);const L=(x:Mod.BanRecord|null)=>x?`${profileLink(x.byUserId,"Модератор")} | ${x.reason} | ${fmt(x.at)}`:"—";return reply(peer,m,`Информация о блокировках ${await nameLinkOf(t)}\n\nГлобальная блокировка — ${g?"Да":"Нет"}\n${L(g)}\n\nБлокировки в беседах серверов — ${sb?`1) Блокировка сервера <<${server}>> | ${L(sb)}`:"—"}\n\nБлокировка в этой беседе —\n${L(cb)}`);
 }
 if(c==="/ban"||c==="/sban"||c==="/gban"){
  const min=c==="/ban"?"senior_admin":c==="/sban"?"deputy_main_admin":"deputy_spec_admin";if(!await can(peer,actor,min as any))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,true);if(!t)return reply(peer,m,"Вы не указали пользователя");if(await protectedTarget(peer,actor,t))return denyTarget(peer,m);const reason=m.reply_message?reasonFrom(args):reasonFrom(args.slice(1));if(!reason)return reply(peer,m,"Вы не указали причину");const rec={reason,byUserId:actor,byWeight:rr.weight,at:now(),label:server??undefined};if(c==="/ban")await Mod.setChatBan(peer,t,rec);else if(c==="/sban"){if(!server)return reply(peer,m,"Беседа не привязана к серверу");await Mod.setServerBan(server,t,rec);await Mod.kickFromServerChats(server,t)}else{await Mod.setGlobalBan(t,rec);await Mod.kickFromAllSyncedChats(t)}await Mod.logBanEvent(t,{...rec,type:c.slice(1) as any,peerId:peer});if(c==="/ban")await kickFromChat(peer,t);return reply(peer,m,`${await nameLinkOf(actor)} заблокировал-(а) ${await nameLinkOf(t)}\nПричина: ${reason}`);
 }
 if(c==="/unban"||c==="/sunban"||c==="/gunban"){
  const min=c==="/unban"?"deputy_main_admin":c==="/sunban"?"main_admin":"deputy_spec_admin";if(!await can(peer,actor,min as any))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,true);if(!t)return reply(peer,m,"Вы не указали пользователя");const reason=m.reply_message?reasonFrom(args):reasonFrom(args.slice(1));if(!reason)return reply(peer,m,"Вы не указали причину");let rec:Mod.BanRecord|null=null;if(c==="/unban")rec=await Mod.getChatBan(peer,t);else if(c==="/sunban"&&server)rec=await Mod.getServerBan(server,t);else rec=await Mod.getGlobalBan(t);if(!rec)return reply(peer,m,"Блокировка отсутствует");if(rr.weight<=rec.byWeight)return denyTarget(peer,m);if(c==="/unban")await Mod.clearChatBan(peer,t);else if(c==="/sunban"&&server)await Mod.clearServerBan(server,t);else await Mod.clearGlobalBan(t);await Mod.logBanEvent(t,{...rec,type:c.slice(1) as any,peerId:peer});return reply(peer,m,`${await nameLinkOf(actor)} снял-(а) блокировку у ${await nameLinkOf(t)}\nПричина: ${reason}`);
 }
 if(c==="/banlist"){if(!await can(peer,actor,"senior_admin"))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,false),h=await Mod.getBanHistory(t);return reply(peer,m,`Список блокировок ${await nameLinkOf(t)}:\n\n`+(h.length?h.map(x=>`${x.type} | ${x.label??"Название чата"} | ${profileLink(x.byUserId,"Модератор")} | ${x.reason} | ${fmt(x.at)}`).join("\n"):"Отсутствуют"));}
 if(c==="/kick"||c==="/skick"||c==="/gkick"){
  const min=c==="/kick"?"moderator":c==="/skick"?"deputy_main_admin":"deputy_spec_admin";if(!await can(peer,actor,min as any))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,true);if(!t)return reply(peer,m,"Вы не указали пользователя");if(await protectedTarget(peer,actor,t))return denyTarget(peer,m);const reason=m.reply_message?reasonFrom(args):reasonFrom(args.slice(1));if(!reason)return reply(peer,m,"Вы не указали причину");if(c==="/kick")await kickFromChat(peer,t);else if(c==="/skick"&&server)await Mod.kickFromServerChats(server,t);else await Mod.kickFromAllSyncedChats(t);return reply(peer,m,`${await nameLinkOf(actor)} исключил-(а) ${await nameLinkOf(t)}\nПричина: ${reason}`);
 }
 if(c==="/mute"||c==="/unmute"){
  if(!await can(peer,actor,"senior_moderator"))return reply(peer,m,"Недостаточно прав.");const t=await targetId(m,args,true);if(!t)return reply(peer,m,"Вы не указали пользователя");if(await protectedTarget(peer,actor,t))return denyTarget(peer,m);
  if(c==="/unmute"){await Mod.clearMute(peer,t);return reply(peer,m,`${await nameLinkOf(actor)} размьютил-(а) ${await nameLinkOf(t)}`)}
  const minutes=Number(args[0]);if(!Number.isFinite(minutes)||minutes<=0)return reply(peer,m,"Вы не указали время мута");const reason=m.reply_message?reasonFrom(args):reasonFrom(args.slice(1));if(!reason)return reply(peer,m,"Вы не указали причину");await Mod.setMute(peer,t,{reason,byUserId:actor,expiresAt:now()+minutes*60000,targetCmid:m.reply_message?.conversation_message_id,moderatorCmid:m.conversation_message_id});return reply(peer,m,`${await nameLinkOf(actor)} замьютил-(а) ${await nameLinkOf(t)}\nПричина: ${reason}\nМут выдан до: ${fmt(now()+minutes*60000)}`);
 }
 if(c==="/clear"){
  if(!await can(peer,actor,"senior_moderator"))return reply(peer,m,"Недостаточно прав.");const ids:number[]=[];if(m.reply_message?.id)ids.push(Number(m.reply_message.id));for(const f of m.fwd_messages??[])if(f.id)ids.push(Number(f.id));if(!ids.length)return reply(peer,m,"Вы не указали сообщение");for(const id of ids){const author=Number(m.reply_message?.from_id??0);if(author&&await protectedTarget(peer,actor,author))return denyTarget(peer,m)}await deleteMessages(peer,[...new Set(ids),Number(m.id)]);return;
 }
 if(c==="/timeout"){
  if(!await can(peer,actor,"admin"))return reply(peer,m,"Недостаточно прав.");const on=!(await Mod.isTimeoutActive(peer));await Mod.setTimeoutMode(peer,on);return reply(peer,m,on?`${await nameLinkOf(actor)} включил режим тишины\nВыключить: /timeout`:`${await nameLinkOf(actor)} выключил режим тишины`);
 }
 if(c==="/olist"){
  if(!await can(peer,actor,"admin"))return reply(peer,m,"Недостаточно прав.");const members=await getConversationMembers(peer),ids=members.map(x=>x.memberId),info=await getUsersInfo(ids);return reply(peer,m,`${await nameLinkOf(actor)}, список пользователей онлайн\n\n`+ids.map(id=>profileLink(id,`${info.get(id)?.first_name??"id"} ${info.get(id)?.last_name??id}`)).join("\n")+`\n\nВсего в онлайн: ${ids.length}`);
 }
 if(c==="/zov"){if(!await can(peer,actor,"admin"))return reply(peer,m,"Недостаточно прав.");const reason=reasonFrom(args);if(!reason)return reply(peer,m,"Вы не указали причину");const members=await getConversationMembers(peer),tags=members.filter(x=>x.memberId!==actor).map(x=>`[id${x.memberId}|🖤]`).join("");return reply(peer,m,`${tags}\n\n🔔 Вы были вызваны администратором беседы\n\n🖤🖤🖤🖤🖤🖤\n\n❗ Причина вызова: ${reason}`);
 }
 return reply(peer,m,"Неизвестная команда. Используйте /help");
}

async function handleCallback(body:any){
 if(body?.type!=="message_new")return;
 const m=body?.object?.message??body?.object;if(!m)return;
 try{await handleMessage(m)}catch(e){console.error("[BOT]",e)}
}

Deno.serve(async req=>{
 if(req.method!=="POST")return new Response("Black Helper OK");
 let body:any;try{body=await req.json()}catch{return new Response("bad",{status:400})}
 if(body?.type==="confirmation")return new Response(Deno.env.get("VK_CONFIRMATION")??"");
 const secret=Deno.env.get("VK_SECRET");if(secret&&body?.secret!==secret)return new Response("invalid secret",{status:403});
 console.log(`[WEBHOOK] type=${body?.type}`);await handleCallback(body);return new Response("ok");
});
