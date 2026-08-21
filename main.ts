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
 const a=args(text), c=text.trim().split(/\s+/)[0].toLowerCase();
 if(c==="/мп"||c==="/ивент"||c==="/mp"||c==="/event") return send(peer,"Эта команда относится к старому боту. В новом боте она отключена.");
 if(c==="/help"){
  const lines:string[]=["Доступные вам команды:"];
  const all:any[]=[
   ["/sync /delsync /synclist","zsa"],["/addgroup /delgroup /mygroups /type","senadmin"],["/ban /getban /banlist /kick /clear /mute /unmute /setnick /getnick /getacc /removenick /nlist /alt","moder"],["/unban","senadmin"],["/sban /skick","admin"],["/sunban /addsenmoder /delsenmoder","senadmin"],["/gban /gunban /gkick","zsa"],["/addsa /delsa","developer"],["/addzsa /delzsa","sa"],["/addsenadmin /delsenadmin","zsa"],["/addadmin /deladmin","senadmin"],["/addmoder /delmoder","senmoder"],["/timeout","admin"],["/reward /balance /stats /pay /top /gtop","none"]];
  for(const [names,min] of all) if(await can(peer,from,min as S.Role))lines.push(`${names}`); return send(peer,lines.join("\n"));
 }
 if(c==="/alt") return send(peer,["Альтернативные команды:","/clear — чистка","/staff — стафф","/getnick — gnick, никлист","/setnick — snick","/removenick — rnick","/nlist — ники","/getacc — аккаунт","/getban — чекбан","/kick — кик","/mute — мут, заткнуть","/unmute — размут, разоткнуть"].join("\n"));
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
 if(c==="/mygroups"){
  if(!await can(peer,from,"senadmin"))return send(peer,"Недостаточно прав.");
  const ps=await myGroupTargets(from); if(!ps.length)return send(peer,"Список ваших чатов:\nОтсутствуют");
  const rows:string[]=[];for(const p of ps)rows.push(`${await chatName(p)} | ${p}`);return send(peer,"Список ваших чатов:\n"+rows.join("\n"));
 }
 if(c==="/type"){if(!await can(peer,from,"senadmin"))return send(peer,"Недостаточно прав.");return send(peer,"Выберите тип беседы:",keyboardType())}
 if(c==="/staff"){
  if(!await can(peer,from,"moder"))return send(peer,"Недостаточно прав.");const m=await getMembers(peer), ids=m.map((x:any)=>x.member_id), inf=await users(ids);const groups:Record<string,number[]>={owner:[],sa:[],zsa:[],senadmin:[],admin:[],senmoder:[],moder:[]};for(const id of ids){const r=await role(peer,id);if(groups[r as string])groups[r as string].push(id)}
  let out=`Владелец беседы — ${groups.owner.length?mention(groups.owner[0],nameOf(groups.owner[0],inf)):"Отсутствует"}\n\n`;
  for(const [r,title] of [["sa","Спец администраторы"],["zsa","Зам.Спец администратора"],["senadmin","Старшие администраторы"],["admin","Администраторы"],["senmoder","Старшие модераторы"],["moder","Модераторы"]] as any)out+=`${title}:\n${groups[r].length?groups[r].map((id:number)=>mention(id,nameOf(id,inf))).join("\n"):"Отсутствуют"}\n\n`;return send(peer,out.trim());
 }
 if(c==="/addsa"||c==="/delsa"||c==="/addzsa"||c==="/delzsa"||c==="/addsenadmin"||c==="/delsenadmin"||c==="/addadmin"||c==="/deladmin"||c==="/addsenmoder"||c==="/delsenmoder"||c==="/addmoder"||c==="/delmoder"){
  const map:any={"/addsa":["developer","sa",1],"/delsa":["developer","sa",0],"/addzsa":["sa","zsa",1],"/delzsa":["sa","zsa",0],"/addsenadmin":["zsa","senadmin",1],"/delsenadmin":["zsa","senadmin",0],"/addadmin":["senadmin","admin",1],"/deladmin":["senadmin","admin",0],"/addsenmoder":["admin","senmoder",1],"/delsenmoder":["admin","senmoder",0],"/addmoder":["senmoder","moder",1],"/delmoder":["senmoder","moder",0]};const [need,rr,on]=map[c];if(!await can(peer,from,need))return send(peer,"Недостаточно прав.");const t=await target(a);if(!t)return send(peer,"Укажите @username.");if(RANK[await role(peer,t)]>=RANK[await role(peer,from)]&&t!==from)return send(peer,"Нельзя изменить роль пользователя равного или выше вас.");if(rr==="zsa"||rr==="sa")await S.setGlobalRole(t,on?rr:"none");else await S.setRole(peer,t,on?rr:"none");return send(peer,on?`${ROLE_RU[rr]} назначен.`:`${ROLE_RU[rr]} снят.`);
 }
 if(c==="/ban"||c==="/unban"||c==="/kick"||c==="/sban"||c==="/sunban"||c==="/skick"||c==="/gban"||c==="/gunban"||c==="/gkick"){
  const req:any={"/ban":"moder","/unban":"senadmin","/kick":"moder","/sban":"admin","/sunban":"senadmin","/skick":"admin","/gban":"zsa","/gunban":"zsa","/gkick":"zsa"};if(!await can(peer,from,req[c]))return send(peer,"Недостаточно прав.");const t=await target(a);if(!t)return send(peer,"Укажите @username.");const reason=a.slice(1).join(" ")||"Причина не указана";
  let peers:number[]=[peer]; if(c==="/sban"||c==="/sunban"||c==="/skick")peers=await myGroupTargets(from); if(c==="/gban"||c==="/gunban"||c==="/gkick")peers=await S.knownChats();
  if(c==="/gban")await S.addBan("global",t,from,reason);if(c==="/gunban")await S.delBan("global",t);for(const p of peers){if(c==="/ban"||c==="/sban")await S.addBan(String(p),t,from,reason);if(c==="/unban"||c==="/sunban")await S.delBan(String(p),t);if(c==="/kick"||c==="/skick"||c==="/gkick"||c==="/ban"||c==="/sban"||c==="/gban")if(isChat(p))await kick(p,t)}
  return send(peer,c.includes("unban")?"Блокировка снята.":c.includes("kick")?"Пользователь кикнут.":"Пользователь заблокирован.");
 }
 if(c==="/getban"||c==="/banlist"){
  if(!await can(peer,from,"moder"))return send(peer,"Недостаточно прав.");const t=await target(a)??from;const scopes=await S.banScopes(t);let out=`Информация о блокировках пользователя ${profile(t)}\n\nГлобальная блокировка — ${scopes.includes("global")?"есть":"отсутствует"} (/gban)\nБлокировка во всех беседах — ${scopes.includes("sync")?"есть":"отсутствует"} (/sban)\nБлокировки в беседах — ${scopes.filter(x=>x!=="global"&&x!=="sync").length?"есть":"отсутствуют"} (/ban)`;if(c==="/banlist")out+=`\n\nАктивных блокировок: ${scopes.length}`;return send(peer,out);
 }
 if(c==="/clear"){
  if(!await can(peer,from,"moder"))return send(peer,"Недостаточно прав.");const rm=message.reply_message?.from_id??uid(a[0]??"");if(!rm)return send(peer,"Ответьте на сообщение пользователя.");if(RANK[await role(peer,rm)]>RANK[await role(peer,from)])return send(peer,"Нельзя очищать сообщения пользователей выше по рангу.");const cm=message.reply_message?.conversation_message_id;if(cm)await deleteCmid(peer,cm);return send(peer,"Сообщение очищено.");
 }
 if(c==="/mute"||c==="/unmute"){
  if(!await can(peer,from,"moder"))return send(peer,"Недостаточно прав.");const t=await target(a);if(!t)return send(peer,"Укажите @username.");if(c==="/unmute"){await S.delMute(peer,t);return send(peer,"Мут снят.")}const mins=+(a[1]??0);if(!mins)return send(peer,"Формат: /mute @username время причина");await S.addMute(peer,t,Date.now()+mins*60000,a.slice(2).join(" ")||"Причина не указана",from);return send(peer,"Пользователь получил мут.");
 }
 if(c==="/timeout"){if(!await can(peer,from,"admin"))return send(peer,"Недостаточно прав.");const on=(a[0]??"on")!=="off";await S.timeout(peer,on);return send(peer,on?"Режим тишины включен.":"Режим тишины выключен.")}
 if(c==="/setnick"||c==="/removenick"||c==="/getnick"||c==="/getacc"||c==="/nlist"){
  if(!await can(peer,from,"moder"))return send(peer,"Недостаточно прав.");if(c==="/nlist"){const ns=await S.allNicks(peer);return send(peer,"Ники в чате:\n"+(ns.length?ns.map(x=>mention(x.id)+` — ${x.nick}`).join("\n"):"Отсутствуют"))}
  if(c==="/getacc"){const id=await S.getUserIdByNick(peer,a.join(" "));return send(peer,id?profile(id):"Пользователь с таким ником не найден.")}
  const t=await target(a)??from;if(c==="/getnick")return send(peer,(await S.getNick(peer,t))??"Ник не установлен.");if(c==="/removenick"){await S.setNick(peer,t,"");return send(peer,"Ник удален.")}const n=a.slice(1).join(" ");if(!n)return send(peer,"Укажите ник.");await S.setNick(peer,t,n);return send(peer,"Ник установлен.");
 }
 if(c==="/reward"||c==="/balance"||c==="/stats"||c==="/pay"||c==="/top"||c==="/gtop"){if(await S.getChatType(peer)!=="players")return send(peer,"Команда доступна только в беседе игроков.");
  if(c==="/reward"){const n=await S.reward(peer,from);return send(peer,n===null?"Вы уже получали награду за последние 3 часа.":`Вы получили ${n} монет.`)}
  if(c==="/balance"){const t=await target(a)??from;return send(peer,`Баланс ${mention(t)}: ${await S.balance(peer,t)} монет`)}
  if(c==="/stats"){const t=await target(a)??from;const st=await S.stats(peer,t);return send(peer,`Информация о пользователе ${profile(t)}\nРоль: ${ROLE_RU[await role(peer,t)]}\nБаланс: ${st.coins} монет\nНик: ${st.nick||"Нет"}\nВсего сообщений: ${st.messages}\nПоследнее сообщение: ${st.last?new Date(st.last).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})+" МСК (UTC+3)":"Нет"}`)}
  if(c==="/pay"){const t=await target(a),n=+(a[1]??0);if(!t||!n)return send(peer,"Формат: /pay @username количество");return send(peer,await S.pay(peer,from,t,n)?"Монеты переданы.":"Недостаточно монет.")}
  if(c==="/top"){const rows=await S.top(peer);return send(peer,"🏆 ТОП по балансу в чате\n\n"+(rows.length?rows.map((x,i)=>`${i+1}. ${mention(x.id)} — ${x.coins} монет`).join("\n"):"Пока пусто"))}
  const rows=await S.top(peer,true);return send(peer,"🏆 ТОП среди всех пользователей\n\n"+(rows.length?rows.map((x,i)=>`${i+1}. ${mention(x.id)} — ${x.coins} монет`).join("\n"):"Пока пусто"));
 }
}

async function handleEvent(body:any){
 if(body.type==="message_event"){
  const o=body.object,p=o.peer_id,u=o.user_id;let pl:any;try{pl=typeof o.payload==="string"?JSON.parse(o.payload):o.payload}catch{return};
  await vk("messages.sendMessageEventAnswer",{event_id:o.event_id,user_id:u,peer_id:p});
  if(!isChat(p))return;
  if(pl?.a==="type"&&await can(p,u,"senadmin")){await S.setChatType(p,pl.v);await send(p,`Вы установили тип беседы "${pl.v==="admin"?"Административный чат":"Беседа игроков"}"`)}
  return;
 }
 if(body.type!=="message_new")return;
 const m=body.object?.message;if(!m){console.warn("[VK] message_new без object.message");return}
 const p=Number(m.peer_id),u=Number(m.from_id),t=(m.text??"").trim();
 console.log(`[VK] message_new peer=${p} from=${u} chat=${isChat(p)} text=${JSON.stringify(t.slice(0,100))}`);
 // Личные сообщения полностью игнорируем. Бот работает только в беседах, где он присутствует.
 if(!isChat(p))return;
 try{
  await S.setChatInfo(p,`Беседа ${p-2000000000}`,await owner(p));
  if(await S.getChatType(p)==="players")await S.addMessage(p,u);await S.touchMessage(p,u);
  const banned=await S.getBan(String(p),u);const global=await S.getBan("global",u);const mute=await S.getMute(p,u);
  if(global||banned){await kick(p,u);return}if(await S.isTimeout(p)&&!await can(p,u,"admin")){await deleteCmid(p,m.conversation_message_id);return}if(mute){await deleteCmid(p,m.conversation_message_id);return}
  if(t.startsWith("/"))await cmd(p,u,t,m);
  if(t&&!t.startsWith("/")){const h=Math.abs([...t.toLowerCase().trim()].reduce((a,c)=>(a*31+c.charCodeAt(0))|0,7));const k=`newbot:flood:${p}:${u}:${h}`;const n=await (await import("./kv.ts")).redis.incr(k);if(n===1)await (await import("./kv.ts")).redis.expire(k,10);if(n>=5){await kick(p,u);await (await import("./kv.ts")).redis.del(k);}}
 }catch(e){console.error(`[BOT] Ошибка обработки peer=${p} from=${u}:`,e)}
}

Deno.serve(async req=>{
 if(req.method!=="POST")return new Response("Bot is running",{status:200});
 let b:any;try{b=await req.json()}catch(e){console.error("[WEBHOOK] invalid JSON",e);return new Response("bad",{status:400})}
 console.log(`[WEBHOOK] type=${b?.type??"unknown"}`);
 if(b?.type==="confirmation")return new Response(Deno.env.get("VK_CONFIRMATION")??"",{status:200});
 const secret=Deno.env.get("VK_SECRET");if(secret&&b?.secret!==secret)return new Response("invalid secret",{status:403});
 // VK должен получить ответ быстро. Обработку сообщения выполняем отдельно.
 if(b?.type==="message_new"||b?.type==="message_event"){
  void handleEvent(b).catch(e=>console.error("[WEBHOOK] handler error",e));
 }
 return new Response("ok",{status:200});
});
