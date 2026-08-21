const VK_TOKEN=Deno.env.get("VK_TOKEN")??"";
const V="5.199";

export async function vk(method:string,params:Record<string,string|number|undefined>={}):Promise<any>{
  const p=new URLSearchParams();
  for(const [k,v] of Object.entries(params))if(v!==undefined)p.set(k,String(v));
  p.set("access_token",VK_TOKEN);p.set("v",V);
  try{const r=await fetch(`https://api.vk.com/method/${method}`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p});const d=await r.json();if(d.error)console.error(`[VK API] ${method}:`,JSON.stringify(d.error));return d}catch(e){console.error(`[VK HTTP] ${method}:`,e);return {error:{error_msg:String(e)}}}
}
export function isChat(peer:number){return Number.isFinite(peer)&&peer>=2000000000}
export function uid(text:string):number|null{let m=text.match(/\[id(\d+)\|/);if(m)return +m[1];m=text.match(/(?:id|club)(\d+)/i);if(m)return +m[1];m=text.trim().match(/^\d+$/);return m?+m[0]:null}
export function mention(id:number,name?:string){return `[id${id}|${name??`id${id}`}]`}
async function latestCmid(peer:number):Promise<number|undefined>{if(!isChat(peer))return undefined;try{const d=await vk("messages.getHistory",{peer_id:peer,count:5});const items=d?.response?.items;if(!Array.isArray(items))return undefined;const m=items.find((x:any)=>Number(x.from_id)>0&&x.conversation_message_id);return m?.conversation_message_id?Number(m.conversation_message_id):undefined}catch(e){console.error("[VK REPLY] failed",e);return undefined}}
export async function send(peer:number,text:string,keyboard?:any){const reply_to=await latestCmid(peer);const d=await vk("messages.send",{peer_id:peer,message:text,random_id:Date.now()%2147483647,reply_to,keyboard:keyboard?JSON.stringify(keyboard):undefined});console.log(`[VK SEND] peer=${peer} reply_to=${reply_to??"none"} response=${JSON.stringify(d?.response??null)} error=${JSON.stringify(d?.error??null)}`);return d?.response}
export async function removeUser(peer:number,user:number){return vk("messages.removeChatUser",{chat_id:peer-2000000000,user_id:user})}
export async function getMembers(peer:number){const d=await vk("messages.getConversationMembers",{peer_id:peer});return d?.response?.items??[]}
export async function users(ids:number[]){if(!ids.length)return [];const d=await vk("users.get",{user_ids:ids.join(",")});return d?.response??[]}
export function profile(id:number){return `https://vk.com/id${id}`}
