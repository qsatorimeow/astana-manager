const VK_TOKEN=Deno.env.get("VK_TOKEN")??"";
const VK_API_VERSION="5.199";
export async function callVkApi(method:string,params:Record<string,string>={}):Promise<any>{
  const body=new URLSearchParams({...params,access_token:VK_TOKEN,v:VK_API_VERSION});
  try{const res=await fetch(`https://api.vk.com/method/${method}`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});const data=await res.json();if(data.error)console.error(`[VK API] ${method}:`,JSON.stringify(data.error));return data}catch(e){console.error(`[VK HTTP] ${method}:`,e);return{error:{error_msg:String(e)}}}
}
export interface VkUserInfo{id:number;first_name:string;last_name:string}
export async function getUsersInfo(ids:number[]):Promise<Map<number,VkUserInfo>>{const out=new Map<number,VkUserInfo>();const x=[...new Set(ids.filter(id=>id>0))];if(!x.length)return out;const d=await callVkApi("users.get",{user_ids:x.join(",")});for(const u of d?.response??[])out.set(u.id,{id:u.id,first_name:u.first_name,last_name:u.last_name});return out}
export function profileLink(id:number,name:string){return`[id${id}|${name}]`}
export async function nameLinkOf(id:number){const m=await getUsersInfo([id]);const u=m.get(id);return profileLink(id,u?`${u.first_name} ${u.last_name}`:`id${id}`)}
export const nameLinkOfAny=nameLinkOf;
export interface ConversationMember{memberId:number;isOwner:boolean;isAdmin:boolean}
export async function getConversationMembers(peerId:number):Promise<ConversationMember[]>{const d=await callVkApi("messages.getConversationMembers",{peer_id:String(peerId)});return(d?.response?.items??[]).map((x:any)=>({memberId:Number(x.member_id),isOwner:!!x.is_owner,isAdmin:!!x.is_admin}))}
export const getMembers=getConversationMembers;
export function isChatPeer(peerId:number){return peerId>=2000000000}
export const isChat=isChatPeer;
export function toChatId(peerId:number){return peerId-2000000000}
export async function kickFromChat(peerId:number,userId:number){return callVkApi("messages.removeChatUser",{chat_id:String(toChatId(peerId)),member_id:String(userId)})}
export async function resolveScreenName(name:string):Promise<number|null>{const d=await callVkApi("utils.resolveScreenName",{screen_name:name});return d?.response?.type==="user"?Number(d.response.object_id):null}
export async function resolveTargetUserId(raw:string):Promise<number|null>{let s=raw.trim();if(!s)return null;let m=s.match(/\[id(\d+)\|/);if(m)return+m[1];s=s.replace(/^https?:\/\/(www\.)?(vk\.com|vk\.ru)\//i,"").replace(/^@/,"");m=s.match(/^id(\d+)$/i);if(m)return+m[1];if(/^\d+$/.test(s))return+s;return resolveScreenName(s)}
export interface SentMessageIds{messageId?:number;conversationMessageId?:number}
export async function sendMessageAndGetIds(peerId:number,text:string,options?:{keyboard?:string;replyToConversationMessageId?:number}):Promise<SentMessageIds>{const p:Record<string,string>={peer_id:String(peerId),message:text,random_id:String(Math.floor(Math.random()*2147483647))};if(options?.keyboard)p.keyboard=options.keyboard;if(options?.replyToConversationMessageId)p.forward=JSON.stringify({peer_id:peerId,conversation_message_ids:[options.replyToConversationMessageId],is_reply:true});const d=await callVkApi("messages.send",p);const id=Number(d?.response??0);if(id>0)return{messageId:id};return{}}
export async function deleteMessages(peerId:number,messageIds:number[]){if(!messageIds.length)return;await callVkApi("messages.delete",{message_ids:messageIds.join(","),delete_for_all:"1"})}
