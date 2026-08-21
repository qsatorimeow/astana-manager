import {vk,isChat,uid,mention,removeUser,getMembers,users,profile,send} from "./vk.ts";
import * as S from "./store.ts";

const DEV=new Set((Deno.env.get("DEVELOPER_IDS")??"").split(",").map(x=>+x.trim()).filter(Boolean));
const RANK:Record<S.Role,number>={none:0,moder:1,senmoder:2,admin:3,senadmin:4,zsa:6,sa:7,developer:9};
const ROLE_RU:Record<S.Role,string>={none:"Нет",developer:"Разработчик",sa:"Спец. администратор",zsa:"Зам. спец. администратора",senadmin:"Старший администратор",admin:"Администратор",senmoder:"Старший модератор",moder:"Модератор"};
const role=(p:number,u:number)=>DEV.has(u)?Promise.resolve<S.Role>("developer"):S.role(p,u);
const can=async(p:number,u:number,min:S.Role)=>RANK[await role(p,u)]>=RANK[min];

function args(s:string){return s.trim().split(/\s+/).slice(1)}
function nameOf(id:number,infos:any[]){const x=infos.find(x=>x.id===id);return x?`${x.first_name} ${x.last_name}`:`id${id}`}
async function target(a:string[]){return uid(a[0]??"")}
async function chatName(peer:number){const i=await S.getChatInfo(peer);return i?.name??`Беседа ${peer-2000000000}`}
async function owner(peer:number){const m=await getMembers(peer);return m.find((x:any)=>x.is_owner)?.member_id??0}
function keyboardType(){return {inline:true,buttons:[[{action:{type:"callback",label:"Административный чат",payload:JSON.stringify({a:"type",v:"admin"})},color:"primary"},{action:{type:"callback",label:"Беседа игроков",payload:JSON.stringify({a:"type",v:"players"})},color:"positive"}]]}}
async function deleteCmid(peer:number,cmid:number){if(!cmid)return;await vk("messages.delete",{peer_id:peer,cmids:cmid,delete_for_all:1})}
async function kick(peer:number,user:number){await removeUser(peer,user)}
async function myGroupTargets(user:number){return await S.myGroups(user)}

async function cmd(peer:number,from:number,text:string,message:any){
 const a=args(text),c=text.trim().split(/\s+/)[0].toLowerCase();
 console.log(`[COMMAND] peer=${peer} from=${from} command=${c}`);
 if(c==="/help"){
  const lines:string[]=["Доступные вам команды:"];
  const all:any[]=[["/sync /delsync /synclist","zsa"],["/addgroup /delgroup /mygroups /type","senadmin"],["/ban /getban /banlist /kick /clear /mute /unmute /setnick /getnick /getacc /removenick /nlist /alt","moder"],["/unban","senadmin"],["/sban /skick","admin"],["/sunban /addsenmoder /delsenmoder","senadmin"],["/gban /gunban /gkick","zsa"],["/addsa /delsa","developer"],["/addzsa /delzsa","sa"],["/addsenadmin /delsenadmin","zsa"],["/addadmin /deladmin","senadmin"],["/addmoder /delmoder","senmoder"],["/timeout","admin"],["/reward /balance /stats /pay /top /gtop","none"]];
  for(const [names,min] of all)if(await can(peer,from,min as S.Role))lines.push(names);return send(peer,lines.join("\n"));
 }
 if(c==="/sync"||c==="/delsync"||c==="/synclist"){
  if(!await can(peer,from,"zsa"))return send(peer,"Недостаточно прав.");
  if(c==="/sync"){await S.addSync(peer);return send(peer,"Синхронизация с базой данных прошла успешно!")}
  if(c==="/delsync"){await S.delSync(peer);return send(peer,"Синхронизация с базой данных удалена")}
  const rows=[];for(const p of await S.syncChats())rows.push(`${await chatName(p)} | ${profile((await S.getChatInfo(p))?.owner?+(await S.getChatInfo(p))!.owner:0)}`);return send(peer,"Список синхронизированных чатов:\n"+(rows.join("\n")||"Отсутствуют"));
 }
 if(c==="/addgroup"||c==="/delgroup"){
  if(!await can(peer,from,"senadmin"))return send(peer,"Недостаточно прав.");const p=uid(a[0]??"")??peer;if(!isChat(p))return send(peer,"Укажите id беседы или используйте команду внутри беседы.");
  if(c==="/addgroup"){await S.addMyGroup(from,p);return send(peer,"Данная беседа добавлена в список ваших чатов")};await S.delMyGroup(from,p);return send(peer,"Данная беседа удалена из списка ваших чатов");
 }
 if(c==="/mygroups"){if(!await can(peer,from,"senadmin"))return send(peer,"Недостаточно прав.");const ps=await myGroupTargets(from);if(!ps.length)return send(peer,"Список ваших чатов:\nОтсутствуют");const rows:string[]=[];for(const p of ps)rows.push(`${await chatName(p)} | ${p}`);return send(peer,"Список ваших чатов:\n"+rows.join("\n"))}
 if(c==="/type"){if(!await can(peer,from,"senadmin"))return send(peer,"Недостаточно прав.");return send(peer,"Выберите тип беседы:",keyboardType())}
 if(c==="/staff"){if(!await can(peer,from,"moder"))return send(peer,"Недостаточно прав.");const m=await getMembers(peer),ids=m.map((x:any)=>x.member_id),inf=await users(ids);const groups:Record<string,number[]>={owner:[],sa:[],zsa:[],senadmin:[],admin:[],senmoder:[],moder:[]};for(const id of ids){const r=await role(peer,id);if(groups[r as string])groups[r as string].push(id)}let out=`Владелец беседы — ${groups.owner.length?mention(groups.owner[0],nameOf(groups.owner[0],inf)):"Отсутствует"}\n\n`;for(const [r,title] of [["sa","Спец администраторы"],["zsa","Зам.Спец администратора"],["senadmin","Старшие администраторы"],["admin","Администраторы"],["senmoder","Старшие модераторы"],["moder","Модераторы"]] as any)out+=`${title}:\n${groups[r].length?groups[r].map((id:number)=>mention(id,nameOf(id,inf))).join("\n"):"Отсутствуют"}\n\n`;return send(peer,out.trim())}
 if(c==="/reward"||c==="/balance"||c==="/stats"||c==="/pay"||c==="/top"||c==="/gtop"){if(await S.getChatType(peer)!=="players")return send(peer,"Команда доступна только в беседе игроков.");if(c==="/balance"){const t=await target(a)??from;return send(peer,`Баланс ${mention(t)}: ${await S.balance(peer,t)} монет`)}if(c==="/stats"){const t=await target(a)??from;const st=await S.stats(peer,t);return send(peer,`Информация о пользователе ${profile(t)}\nРоль: ${ROLE_RU[await role(peer,t)]}\nБаланс: ${st.coins} монет\nНик: ${st.nick||"Нет"}\nВсего сообщений: ${st.messages}`)}if(c==="/pay"){const t=await target(a),n=+(a[1]??0);if(!t||!n)return send(peer,"Формат: /pay @username количество");return send(peer,await S.pay(peer,from,t,n)?"Монеты переданы.":"Недостаточно монет.")}if(c==="/top"){const rows=await S.top(peer);return send(peer,"🏆 ТОП по балансу в чате\n\n"+(rows.length?rows.map((x,i)=>`${i+1}. ${mention(x.id)} — ${x.coins} монет`).join("\n"):"Пока пусто"))}const rows=await S.top(peer,true);return send(peer,"🏆 ТОП среди всех пользователей\n\n"+(rows.length?rows.map((x,i)=>`${i+1}. ${mention(x.id)} — ${x.coins} монет`).join("\n"):"Пока пусто"))}
 return send(peer,"Неизвестная команда. Используйте /help");
}

async function handleEvent(body:any){
 console.log(`[EVENT] enter type=${body?.type} object=${typeof body?.object} keys=${body?.object?Object.keys(body.object).join(","):"none"}`);
 if(body?.type==="message_event"){
  const o=body.object,u=Number(o?.user_id),p=Number(o?.peer_id);let pl:any;try{pl=typeof o?.payload==="string"?JSON.parse(o.payload):o?.payload}catch{pl=null}
  console.log(`[EVENT] message_event peer=${p} user=${u}`);if(p&&!isChat(p))return;await vk("messages.sendMessageEventAnswer",{event_id:o.event_id,user_id:u,peer_id:p});if(pl?.a==="type"&&await can(p,u,"senadmin")){await S.setChatType(p,pl.v);await send(p,`Вы установили тип беседы "${pl.v==="admin"?"Административный чат":"Беседа игроков"}"`)}return;
 }
 if(body?.type!=="message_new")return;
 const raw=body?.object;const m=raw?.message??raw;
 console.log(`[EVENT] message_new rawMessage=${!!raw?.message} mType=${typeof m} peer=${m?.peer_id} from=${m?.from_id}`);
 if(!m||typeof m!=="object"){console.error("[EVENT] message_new: сообщение не найдено");return}
 const p=Number(m.peer_id),u=Number(m.from_id),t=(m.text??"").trim();
 console.log(`[VK] message_new peer=${p} from=${u} chat=${isChat(p)} text=${JSON.stringify(t.slice(0,100))}`);
 if(!isChat(p)){console.log(`[VK] ignore private message peer=${p}`);return}
 try{
  console.log(`[EVENT] chat accepted peer=${p}`);
  await S.setChatInfo(p,`Беседа ${p-2000000000}`,await owner(p));
  if(await S.getChatType(p)==="players")await S.addMessage(p,u);await S.touchMessage(p,u);
  const banned=await S.getBan(String(p),u),global=await S.getBan("global",u),mute=await S.getMute(p,u);
  if(global||banned){await kick(p,u);return}if(await S.isTimeout(p)&&!await can(p,u,"admin")){await deleteCmid(p,m.conversation_message_id);return}if(mute){await deleteCmid(p,m.conversation_message_id);return}
  if(t.startsWith("/"))await cmd(p,u,t,m);
 }catch(e){console.error(`[BOT] Ошибка обработки peer=${p} from=${u}:`,e)}
}

Deno.serve(async req=>{
 if(req.method!=="POST")return new Response("Bot is running",{status:200});
 let b:any;try{b=await req.json()}catch(e){console.error("[WEBHOOK] invalid JSON",e);return new Response("bad",{status:400)}
 console.log(`[WEBHOOK] type=${b?.type??"unknown"}`);
 if(b?.type==="confirmation")return new Response(Deno.env.get("VK_CONFIRMATION")??"",{status:200});
 const secret=Deno.env.get("VK_SECRET");if(secret&&b?.secret!==secret)return new Response("invalid secret",{status:403});
 if(b?.type==="message_new"||b?.type==="message_event")void handleEvent(b).catch(e=>console.error("[WEBHOOK] handler error",e));
 return new Response("ok",{status:200});
});
