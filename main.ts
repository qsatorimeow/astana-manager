import {vk,isChat,uid,mention,getMembers,send} from "./vk.ts";
import * as S from "./store.ts";

const DEV=new Set((Deno.env.get("DEVELOPER_IDS")??"").split(",").map(x=>+x.trim()).filter(Boolean));
const R:Record<S.Role,number>={none:0,moder:1,senmoder:2,admin:3,senadmin:4,zsa:6,sa:7,developer:9};
const TYPE={admin:"Административный чат",players:"Беседа игроков"} as const;
const command=(s:string)=>s.trim().split(/\s+/)[0].toLowerCase();
const args=(s:string)=>s.trim().split(/\s+/).slice(1);
async function owner(p:number){const m=await getMembers(p);return m.find((x:any)=>x.is_owner)?.member_id??0}
async function role(p:number,u:number):Promise<S.Role>{if(DEV.has(u))return "developer";const i=await S.getChatInfo(p);if(Number(i?.owner)===u)return "senadmin";return S.role(p,u)}
async function can(p:number,u:number,min:S.Role){return R[await role(p,u)]>=R[min]}
async function reply(p:number,m:any,text:string,keyboard?:any){return send(p,text,keyboard,Number(m.conversation_message_id||m.id)||undefined)}
function typeKeyboard(){return {inline:true,buttons:[[{action:{type:"callback",label:"Административный чат",payload:JSON.stringify({a:"type",v:"admin"})},color:"primary"},{action:{type:"callback",label:"Беседа игроков",payload:JSON.stringify({a:"type",v:"players"})},color:"positive"}]]}}

async function onMessage(m:any){
 const p=Number(m.peer_id),u=Number(m.from_id),text=String(m.text??"").trim();
 console.log(`[MESSAGE] peer=${p} user=${u} text=${JSON.stringify(text)} chat=${isChat(p)}`);
 if(!isChat(p))return; // LС полностью игнорируются.
 const c=command(text),open=["/sync","/delsync","/synclist"];
 if(!await S.isActive(p)&&!open.includes(c)){console.log(`[IGNORE] peer=${p} not active`);return}
 if(!await S.getChatInfo(p))await S.setChatInfo(p,`Беседа ${p-2000000000}`,await owner(p));
 console.log(`[CMD] peer=${p} user=${u} command=${c} active=${await S.isActive(p)} sync=${await S.isSync(p)} type=${await S.getChatType(p)} dev=${DEV.has(u)}`);
 if(c==="/sync"){
  if(!await can(p,u,"zsa"))return reply(p,m,"Недостаточно прав.");
  await S.addSync(p);await S.setChatInfo(p,`Беседа ${p-2000000000}`,await owner(p));
  return reply(p,m,"Синхронизация с базой данных прошла успешно!");
 }
 if(c==="/delsync"){
  if(!await can(p,u,"zsa"))return reply(p,m,"Недостаточно прав.");
  await S.delSync(p);return reply(p,m,"Синхронизация с базой данных удалена");
 }
 if(c==="/synclist"){
  if(!await can(p,u,"zsa"))return reply(p,m,"Недостаточно прав.");
  const rows=[];for(const x of await S.syncChats()){const i=await S.getChatInfo(x);rows.push(`${i?.name??`Беседа ${x-2000000000}`} | ${i?.owner?mention(+i.owner):"—"}`)}
  return reply(p,m,"Список синхронизированных чатов:\n"+(rows.join("\n")||"Отсутствуют"));
 }
 if(c==="/addgroup"){
  if(!await can(p,u,"senadmin"))return reply(p,m,"Недостаточно прав.");
  const target=uid(args(text)[0]??"")??p;if(!isChat(target))return reply(p,m,"Используйте /addgroup внутри беседы или укажите id беседы.");
  if(!await S.isSync(target))return reply(p,m,"Сначала выполните /sync в этой беседе.");
  await S.addMyGroup(u,target);return reply(p,m,"Данная беседа добавлена в список ваших чатов");
 }
 if(c==="/delgroup"){
  if(!await can(p,u,"senadmin"))return reply(p,m,"Недостаточно прав.");
  const target=uid(args(text)[0]??"")??p;if(!isChat(target))return reply(p,m,"Используйте /delgroup внутри беседы или укажите id беседы.");
  await S.delMyGroup(u,target);return reply(p,m,"Данная беседа удалена из списков ваших чатов");
 }
 if(c==="/mygroups"){
  if(!await can(p,u,"senadmin"))return reply(p,m,"Недостаточно прав.");
  const xs=await S.myGroups(u);return reply(p,m,"Список ваших чатов:\n"+(xs.length?xs.map(x=>`Беседа ${x-2000000000} | ${x}`).join("\n"):"Отсутствуют"));
 }
 if(c==="/type"){
  if(!await can(p,u,"senadmin"))return reply(p,m,"Недостаточно прав.");
  if(!await S.isSync(p))return reply(p,m,"Сначала выполните /sync в этой беседе.");
  if(!(await S.myGroups(u)).includes(p))return reply(p,m,"Сначала выполните /addgroup в этой беседе.");
  return reply(p,m,"Выберите тип беседы:",typeKeyboard());
 }
 // Остальные команды пока намеренно не запускаются: фундамент должен пройти проверку отдельно.
 return reply(p,m,"Бот подключён. Завершите настройку: /sync → /addgroup → /type");
}

async function handle(b:any){
 console.log(`[WEBHOOK] type=${b?.type}`);
 if(b?.type==="message_event"){
  const o=b.object??{},p=Number(o.peer_id),u=Number(o.user_id);if(!isChat(p))return;
  let payload:any;try{payload=typeof o.payload==="string"?JSON.parse(o.payload):o.payload}catch{payload=null}
  await vk("messages.sendMessageEventAnswer",{event_id:o.event_id,user_id:u,peer_id:p});
  if(payload?.a==="type"&&await can(p,u,"senadmin")&&await S.isSync(p)&&(await S.myGroups(u)).includes(p)){
   await S.setChatType(p,payload.v);await send(p,`Вы установили тип беседы "${TYPE[payload.v as "admin"|"players"]}"`);
  }
  return;
 }
 if(b?.type!=="message_new")return;
 const m=b?.object?.message??b?.object;if(!m)return;
 await onMessage(m);
}

Deno.serve(async req=>{
 if(req.method!=="POST")return new Response("Astana Manager OK");
 let b:any;try{b=await req.json()}catch(e){console.error("[WEBHOOK] invalid JSON",e);return new Response("bad",{status:400})}
 if(b?.type==="confirmation")return new Response(Deno.env.get("VK_CONFIRMATION")??"");
 const secret=Deno.env.get("VK_SECRET");if(secret&&b?.secret!==secret)return new Response("invalid secret",{status:403});
 void handle(b).catch(e=>console.error("[WEBHOOK FATAL]",e));return new Response("ok");
});
