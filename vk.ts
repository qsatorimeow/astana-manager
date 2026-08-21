const VK_TOKEN=Deno.env.get("VK_TOKEN")??"";
const V="5.199";

// VK Callback API: message_new has the message directly in object.
// main.ts historically expects object.message, so normalize it here.
// Also log the normalization so Deno logs show exactly what VK sent.
const _json=Request.prototype.json;
const _patchedJson=async function(this:Request){
  const body:any=await _json.call(this);
  console.log(`[VK] parsed callback type=${body?.type??"unknown"}`);
  if(body?.type==="message_new" && body.object){
    if(!body.object.message){
      console.log("[VK] normalizing message_new: object -> object.message");
      body.object={message:body.object};
    }else{
      console.log("[VK] message_new already contains object.message");
    }
  }
  return body;
};
try{
  Object.defineProperty(Request.prototype,"json",{value:_patchedJson,writable:true,configurable:true});
}catch(e){
  console.warn("[VK] Request.json defineProperty failed, using direct patch",e);
  try{Request.prototype.json=_patchedJson as typeof Request.prototype.json}catch{}
}

export async function vk(method:string, params:Record<string,string|number|undefined>={}):Promise<any>{
 const p=new URLSearchParams(); for(const [k,v] of Object.entries(params)) if(v!==undefined)p.set(k,String(v)); p.set("access_token",VK_TOKEN);p.set("v",V);
 const r=await fetch(`https://api.vk.com/method/${method}`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p}); const d=await r.json(); if(d.error) console.error(`[VK] ${method}`,d.error); return d;
}
export function isChat(peer:number){return peer>=2000000000}
export function uid(text:string):number|null{let m=text.match(/\[id(\d+)\|/);if(m)return +m[1];m=text.match(/(?:id|club)(\d+)/i);if(m)return +m[1];m=text.trim().match(/^\d+$/);return m?+m[0]:null}
export function mention(id:number,name?:string){return `[id${id}|${name??`id${id}`}]`}
export async function send(peer:number,text:string,keyboard?:any){const d=await vk("messages.send",{peer_id:peer,message:text,random_id:Math.floor(Math.random()*2**31-1),keyboard:keyboard?JSON.stringify(keyboard):undefined});return d?.response}
export async function removeUser(peer:number,user:number){return vk("messages.removeChatUser",{chat_id:peer-2000000000,user_id:user})}
export async function getMembers(peer:number){const d=await vk("messages.getConversationMembers",{peer_id:peer});return d?.response?.items??[]}
export async function users(ids:number[]){const d=await vk("users.get",{user_ids:ids.join(",")});return d?.response??[]}
export function profile(id:number){return `https://vk.com/id${id}`}
