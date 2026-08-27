const TOKEN=Deno.env.get("VK_TOKEN")??"";
const VERSION="5.199";
export async function callVkApi(method:string,params:Record<string,string|number|undefined>={}):Promise<any>{
 const p=new URLSearchParams();for(const[k,v]of Object.entries(params))if(v!==undefined)p.set(k,String(v));p.set("access_token",TOKEN);p.set("v",VERSION);
 try{const r=await fetch(`https://api.vk.com/method/${method}`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:p});const d=await r.json();if(d.error)console.error(`[VK API] ${method}`,JSON.stringify(d.error));return d}catch(e){console.error(`[VK HTTP] ${method}`,e);return{error:{error_msg:String(e)}}}
}
export function isChatPeer(peer:number){return Number.isFinite(peer)&&peer>=2000000000}
export const isChat=isChatPeer;
export function toChatId(peer:number){return peer-2000000000}
export async function getMembers(peer:number){const d=await callVkApi("messages.getConversationMembers",{peer_id:peer});return d?.response?.items??[]}
export async function getUsersInfo(ids:number[]){const out=new Map<number,any>();const x=[...new Set(ids.filter(Boolean))];if(!x.length)return out;const d=await callVkApi("users.get",{user_ids:x.join(",")});for(const u of d?.response??[])out.set(Number(u.id),u);return out}
export function profileLink(id:number,name:string){return`[id${id}|${name}]`}
export async function nameLinkOf(id:number){const m=await getUsersInfo([id]);const u=m.get(id);return profileLink(id,u?`${u.first_name} ${u.last_name}`:`id${id}`)}
export async function resolveTargetUserId(raw:string):Promise<number|null>{let s=raw.trim();if(!s)return null;let m=s.match(/\[id(\d+)\|/);if(m)return Number(m[1]);s=s.replace(/^https?:\/\/(www\.)?(vk\.com|vk\.ru)\//i,"").replace(/^@/,"");m=s.match(/^id(\d+)$/i);if(m)return Number(m[1]);if(/^\d+$/.test(s))return Number(s);const d=await callVkApi("utils.resolveScreenName",{screen_name:s});return d?.response?.type==="user"?Number(d.response.object_id):null}
export async function sendMessageAndGetIds(peer:number,text:string,opts:{replyTo?:number;keyboard?:any}={}):Promise<{messageId?:number;conversationMessageId?:number}>{
 const p:any={peer_id:peer,message:text,random_id:Math.floor(Math.random()*2147483647)};
 if(opts.replyTo){
   // In VK conversations the reliable way to create a visual reply is the forward
   // object with the conversation_message_id and is_reply=true. Using only
   // messages.send.reply_to can attach to an unrelated message in a conversation.
   p.forward=JSON.stringify({peer_id:peer,conversation_message_ids:[Number(opts.replyTo)],is_reply:1});
 }
 if(opts.keyboard)p.keyboard=typeof opts.keyboard==="string"?opts.keyboard:JSON.stringify(opts.keyboard);
 const d=await callVkApi("messages.send",p);
 console.log(`[VK SEND] peer=${peer} reply_to_cmid=${opts.replyTo??"-"} response=${JSON.stringify(d?.response??null)}`);
 const id=Number(d?.response??0);return id>0?{messageId:id}:{}
}
export const send=sendMessageAndGetIds;
export async function deleteMessages(peer:number,ids:number[]){if(ids.length)await callVkApi("messages.delete",{message_ids:ids.join(","),delete_for_all:1})}
export async function kickFromChat(peer:number,user:number){return callVkApi("messages.removeChatUser",{chat_id:toChatId(peer),member_id:user})}
