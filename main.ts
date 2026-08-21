import {vk,isChat,uid,mention,removeUser,getMembers,users,profile,send} from "./vk.ts";
import * as S from "./store.ts";

const DEV=new Set((Deno.env.get("DEVELOPER_IDS")??"").split(",").map(x=>+x.trim()).filter(Boolean));
const RANK:Record<S.Role,number>={none:0,moder:1,senmoder:2,admin:3,senadmin:4,zsa:6,sa:7,developer:9};
const ROLE_RU:Record<S.Role,string>={none:"Нет",developer:"Разработчик",sa:"Спец. администратор",zsa:"Зам. спец. администратора",senadmin:"Старший администратор",admin:"Администратор",senmoder:"Старший модератор",moder:"Модератор"};
const TYPE_RU={admin:"Административный чат",players:"Беседа игроков"} as const;

const args=(s:string)=>s.trim().split(/\s+/).slice(1);
const command=(s:string)=>s.trim().split(/\s+/)[0].toLowerCase();
const nameOf=(id:number,inf:any[])=>{const x=inf.find(x=>x.id===id);return x?`${x.first_name} ${x.last_name}`:`id${id}`};
const fmtDate=(ts:number)=>!ts?"Нет":new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(ts)).replace(","," ")+" МСК (UTC+3)";
async function owner(p:number){const m=await getMembers(p);return m.find((x:any)=>x.is_owner)?.member_id??0}
async function role(p:number,u:number):Promise<S.Role>{if(DEV.has(u))return "developer";const o=(await S.getChatInfo(p))?.owner;return Number(o)===u?"senadmin":S.role(p,u)}
async function can(p:number,u:number,min:S.Role){return RANK[await role(p,u)]>=RANK[min]}
async function deny(p:number){return send(p,"Недостаточно прав.")}
async function target(p:number,a:string[]){if(!a[0])return null;return uid(a[0])??await S.getUserIdByNick(p,a[0])}
async function kick(p:number,u:number){return removeUser(p,u)}
async function chatName(p:number){return (await S.getChatInfo(p))?.name??`Беседа ${p-2000000000}`}
async function delCmid(p:number,cmid:number){if(cmid)await vk("messages.delete",{peer_id:p,cmids:cmid,delete_for_all:1})}
async function groups(u:number){return S.myGroups(u)}

function typeKeyboard(){return {inline:true,buttons:[[{action:{type:"callback",label:"Административный чат",payload:JSON.stringify({a:"type",v:"admin"})},color:"primary"},{action:{type:"callback",label:"Беседа игроков",payload:JSON.stringify({a:"type",v:"players"})},color:"positive"}]]}}

async function help(p:number,u:number){
 const list:[string,S.Role][]=[["/sync /delsync /synclist","zsa"],["/addgroup /delgroup /mygroups /type","senadmin"],["/ban /getban /banlist /kick /clear /mute /unmute /setnick /getnick /getacc /removenick /nlist /alt","moder"],["/unban /sunban","senadmin"],["/sban /skick","admin"],["/gban /gunban /gkick","zsa"],["/addsa /delsa","developer"],["/addzsa /delzsa","sa"],["/addsenadmin /delsenadmin","zsa"],["/addadmin /deladmin","senadmin"],["/addsenmoder /delsenmoder","admin"],["/addmoder /delmoder","senmoder"],["/timeout","admin"],["/reward /balance /stats /pay /top /gtop","none"]];
 const out=["Список доступных вам команд:"];for(const [names,min] of list)if(await can(p,u,min))out.push(names);return send(p,out.join("\n"));
}

async function staff(p:number){
 const ms=await getMembers(p),ids=ms.map((x:any)=>x.member_id),inf=await users(ids),g:any={owner:[],sa:[],zsa:[],senadmin:[],admin:[],senmoder:[],moder:[]};
 for(const id of ids){const r=await role(p,id);if(g[r])g[r].push(id)}
 let out=`Владелец беседы — ${g.owner.length?mention(g.owner[0],nameOf(g.owner[0],inf)):"Отсутствует"}\n\n`;
 for(const [r,t] of [["sa","Спец администраторы"],["zsa","Зам.Спец администратора"],["senadmin","Старшие администраторы"],["admin","Администраторы"],["senmoder","Старшие модераторы"],["moder","Модераторы"]] as any)out+=`${t}:\n${g[r].length?g[r].map((id:number)=>mention(id,nameOf(id,inf))).join("\n"):"Отсутствуют"}\n\n`;
 return send(p,out.trim());
}

async function roleChange(p:number,u:number,t:number,nr:S.Role,min:S.Role,global=false){
 if(!await can(p,u,min))return deny(p);if(t===u)return send(p,"Нельзя изменить роль самому себе.");const old=await role(p,t);if(old!=="none"&&RANK[old]>=RANK[await role(p,u)])return send(p,"Нельзя изменить роль пользователя с равным или более высоким рангом.");if(global)await S.setGlobalRole(t,nr);else await S.setRole(p,t,nr);return send(p,nr==="none"?"Роль пользователя снята.":`Назначена роль: ${ROLE_RU[nr]}.`)
}

async function cmd(p:number,u:number,text:string){
 const a=args(text),c=command(text);
 if(c==="/help")return help(p,u);
 if(c==="/sync"||c==="/delsync"||c==="/synclist"){
  if(!await can(p,u,"zsa"))return deny(p);
  if(c==="/sync"){await S.setChatInfo(p,await chatName(p),await owner(p));await S.addSync(p);return send(p,"Синхронизация с базой данных прошла успешно!")}
  if(c==="/delsync"){await S.delSync(p);return send(p,"Синхронизация с базой данных удалена")}
  const rows=[];for(const x of await S.syncChats()){const i=await S.getChatInfo(x);rows.push(`${i?.name??`Беседа ${x-2000000000}`} | ${i?.owner?profile(+i.owner):"—"}`)}return send(p,"Список синхронизированных чатов:\n"+(rows.join("\n")||"Отсутствуют"));
 }
 if(c==="/addgroup"||c==="/delgroup"){
  if(!await can(p,u,"senadmin"))return deny(p);const q=uid(a[0]??"")??p;if(!isChat(q))return send(p,"Укажите id беседы или используйте команду внутри беседы.");
  if(c==="/addgroup"&&!await S.isSync(q))return send(p,"Сначала выполните /sync в этой беседе.");
  if(c==="/addgroup"){await S.addMyGroup(u,q);return send(p,"Данная беседа добавлена в список ваших чатов")}
  await S.delMyGroup(u,q);return send(p,"Данная беседа удалена из списков ваших чатов");
 }
 if(c==="/mygroups"){if(!await can(p,u,"senadmin"))return deny(p);const xs=await groups(u);return send(p,"Список ваших чатов:\n"+(xs.length?(await Promise.all(xs.map(async x=>`${await chatName(x)} | ${x}`))).join("\n"):"Отсутствуют"))}
 if(c==="/type"){if(!await can(p,u,"senadmin"))return deny(p);if(!await S.isSync(p))return send(p,"Сначала выполните /sync в этой беседе.");if(!(await groups(u)).includes(p))return send(p,"Сначала добавьте эту беседу через /addgroup.");return send(p,"Выберите тип беседы:",typeKeyboard())}
 if(c==="/staff"){if(!await can(p,u,"moder"))return deny(p);return staff(p)}
 if(["/reward","/balance","/stats","/pay","/top","/gtop"].includes(c)){
  if(await S.getChatType(p)!=="players")return send(p,"Команда доступна только в беседе игроков.");
  if(c==="/reward"){const n=await S.reward(p,u);return send(p,n===null?"Вы уже получали награду. Повторно можно через 3 часа.":`🎁 Вы получили ${n} монет!`)}
  const t=await target(p,a)??u;
  if(c==="/balance")return send(p,`Баланс ${mention(t)}: ${await S.balance(p,t)} монет`);
  if(c==="/stats"){const s=await S.stats(p,t);return send(p,`Информация о пользователе ${profile(t)}\nРоль: ${ROLE_RU[await role(p,t)]}\nБаланс: ${s.coins} монет\nНик: ${s.nick||"Нет"}\nВсего сообщений: ${s.messages}\nПоследнее сообщение: ${fmtDate(s.last)}`)}
  if(c==="/pay"){const to=await target(p,a),n=Number(a[1]);if(!to||!Number.isInteger(n)||n<=0)return send(p,"Формат: /pay @username количество");return send(p,await S.pay(p,u,to,n)?`💰 Вы передали ${n} монет пользователю ${mention(to)}.`:"Недостаточно монет.")}
  if(c==="/top"){const rows=await S.top(p);return send(p,"🏆 Топ по балансу в чате:\n\n"+(rows.length?rows.map((x,i)=>`${i+1}. ${mention(x.id)} — ${x.coins} монет`).join("\n"):"Пока пусто"))}
  const rows=await S.globalTop();return send(p,"🌎 Топ среди всех пользователей:\n\n"+(rows.length?rows.map((x,i)=>`${i+1}. ${mention(x.id)} — ${x.coins} монет`).join("\n"):"Пока пусто"));
 }
 if(["/ban","/unban","/sban","/sunban","/gban","/gunban"].includes(c)){
  const t=await target(p,a),reason=a.slice(1).join(" ")||"Не указана";if(!t)return send(p,`Формат: ${c} @username причина`);
  if(c==="/ban"){if(!await can(p,u,"senmoder"))return deny(p);await S.addBan(String(p),t,u,reason);await kick(p,t);return send(p,`Пользователь ${mention(t)} заблокирован в этой беседе.`)}
  if(c==="/unban"){if(!await can(p,u,"senadmin"))return deny(p);await S.delBan(String(p),t);return send(p,`Блокировка ${mention(t)} снята в этой беседе.`)}
  if(c==="/sban"){if(!await can(p,u,"admin"))return deny(p);for(const q of await groups(u)){await S.addBan(String(q),t,u,reason);await kick(q,t)}return send(p,`Пользователь ${mention(t)} заблокирован во всех ваших беседах.`)}
  if(c==="/sunban"){if(!await can(p,u,"senadmin"))return deny(p);for(const q of await groups(u))await S.delBan(String(q),t);return send(p,`Блокировка ${mention(t)} снята во всех ваших беседах.`)}
  if(c==="/gban"){if(!await can(p,u,"zsa"))return deny(p);await S.addBan("global",t,u,reason);for(const q of await S.syncChats()){await S.addBan(String(q),t,u,reason);await kick(q,t)}return send(p,`Пользователь ${mention(t)} глобально заблокирован.`)}
  if(!await can(p,u,"zsa"))return deny(p);await S.delBan("global",t);for(const q of await S.syncChats())await S.delBan(String(q),t);return send(p,`Глобальная блокировка ${mention(t)} снята.`)
 }
 if(c==="/getban"||c==="/banlist"){
  if(!await can(p,u,"moder"))return deny(p);const t=await target(p,a)??u,scopes=await S.banScopes(t);return send(p,`Информация о блокировках пользователя ${profile(t)}\n\nГлобальная блокировка — ${scopes.includes("global")?"активна":"отсутствует"} (/gban)\nБлокировка во всех беседах — ${scopes.some(x=>x!=="global")?"есть":"отсутствует"} (/sban)\nБлокировки в беседах — ${scopes.some(x=>x!=="global")?"есть":"отсутствуют"} (/ban)`)
 }
 if(c==="/kick"||c==="/skick"||c==="/gkick"){
  const t=await target(p,a);if(!t)return send(p,`Формат: ${c} @username причина`);if(c==="/kick"&&!await can(p,u,"moder"))return deny(p);if(c==="/skick"&&!await can(p,u,"admin"))return deny(p);if(c==="/gkick"&&!await can(p,u,"zsa"))return deny(p);const ps=c==="/kick"?[p]:c==="/skick"?await groups(u):await S.syncChats();for(const q of ps)await kick(q,t);return send(p,`Пользователь ${mention(t)} исключён.`)
 }
 if(c==="/clear"){
  if(!await can(p,u,"moder"))return deny(p);const t=await target(p,a);if(!t)return send(p,"Формат: /clear @username");if(RANK[await role(p,t)]>=RANK[await role(p,u)])return send(p,"Нельзя очистить сообщения пользователя с равным или более высоким рангом.");const h=await vk("messages.getHistory",{peer_id:p,count:200});const ids=(h?.response?.items??[]).filter((x:any)=>Number(x.from_id)===t&&x.conversation_message_id).map((x:any)=>x.conversation_message_id).slice(0,100);if(ids.length)await vk("messages.delete",{peer_id:p,cmids:ids.join(","),delete_for_all:1});return send(p,`Удалено сообщений: ${ids.length}.`)
 }
 if(c==="/mute"||c==="/unmute"){
  if(!await can(p,u,"moder"))return deny(p);const t=await target(p,a);if(!t)return send(p,`Формат: ${c} @username ${c==="/mute"?"время в минутах причина":"причина"}`);if(c==="/unmute"){await S.delMute(p,t);return send(p,`Мут с пользователя ${mention(t)} снят.`)}const n=Number(a[1]);if(!Number.isFinite(n)||n<=0)return send(p,"Укажите время в минутах.");await S.addMute(p,t,Date.now()+n*60000,a.slice(2).join(" ")||"Не указана",u);return send(p,`Пользователь ${mention(t)} получил мут на ${n} мин.`)
 }
 if(c==="/timeout"){if(!await can(p,u,"admin"))return deny(p);const on=!a[0]||["on","1","вкл","включить"].includes(a[0].toLowerCase());await S.timeout(p,on);return send(p,on?"🔇 Режим тишины включён. Никто не может писать.":"🔊 Режим тишины выключен.")}
 if(["/setnick","/getnick","/getacc","/removenick","/nlist"].includes(c)){
  if(!await can(p,u,"moder"))return deny(p);
  if(c==="/setnick"){const t=await target(p,a),n=a.slice(1).join(" ");if(!t||!n)return send(p,"Формат: /setnick @username Nick_Name");await S.setNick(p,t,n);return send(p,`Ник пользователя ${mention(t)} установлен: ${n}`)}
  if(c==="/removenick"){const t=await target(p,a);if(!t)return send(p,"Формат: /removenick @username");await S.removeNick(p,t);return send(p,`Ник пользователя ${mention(t)} удалён.`)}
  if(c==="/getnick"){const t=await target(p,a);if(!t)return send(p,"Формат: /getnick @username");return send(p,`Ник пользователя ${mention(t)}: ${await S.getNick(p,t)??"Нет"}`)}
  if(c==="/getacc"){const t=await S.getUserIdByNick(p,a.join(" "));return send(p,t?`Пользователь: ${profile(t)}`:"Пользователь с таким ником не найден.")}
  const ns=await S.allNicks(p);return send(p,"Список ников:\n"+(ns.length?ns.map(x=>`${x.nick} — ${mention(x.id)}`).join("\n"):"Отсутствуют"));
 }
 if(c==="/alt"){if(!await can(p,u,"moder"))return deny(p);return send(p,"Альтернативные команды:\n/clear — чистка\n/staff — стафф\n/getnick — gnick, никлист\n/setnick — snick\n/removenick — rnick\n/nlist — ники\n/getacc — аккаунт\n/getban — чекбан\n/kick — кик\n/mute — мут, заткнуть\n/unmute — размут, разоткнуть")}
 const roleCmd:any={"/addsa":["developer","sa",true],"/delsa":["developer","none",true],"/addzsa":["sa","zsa",true],"/delzsa":["sa","none",true],"/addsenadmin":["zsa","senadmin",true],"/delsenadmin":["zsa","none",true],"/addadmin":["senadmin","admin",false],"/deladmin":["senadmin","none",false],"/addsenmoder":["admin","senmoder",false],"/delsenmoder":["admin","none",false],"/addmoder":["senmoder","moder",false],"/delmoder":["senmoder","none",false]};
 if(roleCmd[c]){const [min,nr,global]=roleCmd[c],t=await target(p,a);if(!t)return send(p,`Формат: ${c} @username`);return roleChange(p,u,t,nr,min,global)}
 return send(p,"Неизвестная команда. Используйте /help");
}

async function handle(body:any){
 if(body?.type==="message_event"){
  const o=body.object,p=Number(o?.peer_id),u=Number(o?.user_id);if(!isChat(p))return;let pl:any;try{pl=typeof o?.payload==="string"?JSON.parse(o.payload):o?.payload}catch{pl=null};await vk("messages.sendMessageEventAnswer",{event_id:o.event_id,user_id:u,peer_id:p});if(pl?.a==="type"&&await can(p,u,"senadmin")&&await S.isSync(p)&&(await S.myGroups(u)).includes(p)){await S.setChatType(p,pl.v);await send(p,`Вы установили тип беседы "${TYPE_RU[pl.v as "admin"|"players"]}"`)}return;
 }
 if(body?.type!=="message_new")return;const m=body?.object?.message??body?.object;if(!m||typeof m!=="object")return;const p=Number(m.peer_id),u=Number(m.from_id),t=(m.text??"").trim();if(!isChat(p))return;
 const c=command(t);if(!await S.isActive(p)&&!['/sync','/delsync','/synclist'].includes(c))return;
 try{
  if(!await S.getChatInfo(p))await S.setChatInfo(p,`Беседа ${p-2000000000}`,await owner(p));
  if(await S.getBan("global",u)||await S.getBan(String(p),u)){await kick(p,u);return}
  if(await S.isTimeout(p)&&!await can(p,u,"admin")){await delCmid(p,m.conversation_message_id);return}
  if(await S.getMute(p,u)){await delCmid(p,m.conversation_message_id);return}
  if(await S.recordMessageFingerprint(p,u,t)){await kick(p,u);return}
  if(await S.getChatType(p)==="players")await S.addMessage(p,u,Number(m.date?m.date*1000:Date.now()));
  if(t.startsWith("/"))await cmd(p,u,t);
 }catch(e){console.error(`[BOT] peer=${p} from=${u}`,e)}
}

Deno.serve(async req=>{
 if(req.method!=="POST")return new Response("Bot is running",{status:200});let b:any;try{b=await req.json()}catch{return new Response("bad",{status:400})};
 if(b?.type==="confirmation")return new Response(Deno.env.get("VK_CONFIRMATION")??"",{status:200});const secret=Deno.env.get("VK_SECRET");if(secret&&b?.secret!==secret)return new Response("invalid secret",{status:403});if(b?.type==="message_new"||b?.type==="message_event")void handle(b).catch(e=>console.error("[WEBHOOK]",e));return new Response("ok",{status:200});
});
