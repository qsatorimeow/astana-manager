import {redis} from "./kv.ts";
export type Role="developer"|"sa"|"zsa"|"senadmin"|"admin"|"senmoder"|"moder"|"none";
const r=(k:string)=>`newbot:${k}`; const chat=(p:number)=>r(`chat:${p}`);
export async function setChatType(peer:number,type:"admin"|"players"){await redis.set(chat(peer)+":type",type)}
export async function getChatType(peer:number){return (await redis.get<string>(chat(peer)+":type"))??"admin"}
export async function hasChatType(peer:number){return !!(await redis.get<string>(chat(peer)+":type"))}
export async function setChatInfo(peer:number,name:string,owner:number){await redis.hset(chat(peer)+":info",{name,owner:String(owner)});await redis.sadd(r("known:chats"),String(peer))}
export async function knownChats(){return (await redis.smembers(r("known:chats"))).map(Number)}
export async function getChatInfo(peer:number){return await redis.hgetall<Record<string,string>>(chat(peer)+":info")}
export async function addMyGroup(user:number,peer:number){await redis.sadd(r(`mygroups:${user}`),String(peer))}
export async function delMyGroup(user:number,peer:number){await redis.srem(r(`mygroups:${user}`),String(peer))}
export async function myGroups(user:number){return (await redis.smembers(r(`mygroups:${user}`))).map(Number)}
export async function addSync(peer:number){await redis.sadd(r("sync:chats"),String(peer));await redis.set(r(`sync:${peer}`),"1")}
export async function delSync(peer:number){await redis.srem(r("sync:chats"),String(peer));await redis.del(r(`sync:${peer}`))}
export async function isSync(peer:number){return !!(await redis.get(r(`sync:${peer}`)))}
export async function syncChats(){return (await redis.smembers(r("sync:chats"))).map(Number)}
export async function setRole(peer:number,user:number,role:Role){if(role==="none")await redis.del(chat(peer)+`:role:${user}`);else await redis.set(chat(peer)+`:role:${user}`,role)}
export async function getRole(peer:number,user:number):Promise<Role>{return (await redis.get<Role>(chat(peer)+`:role:${user}`))??"none"}
export async function setGlobalRole(user:number,role:Role){if(role==="none")await redis.del(r(`globalrole:${user}`));else await redis.set(r(`globalrole:${user}`),role)}
export async function getGlobalRole(user:number):Promise<Role>{return (await redis.get<Role>(r(`globalrole:${user}`)))??"none"}
const rank:Record<Role,number>={none:0,moder:1,senmoder:2,admin:3,senadmin:4,zsa:6,sa:7,developer:9};
export async function role(peer:number,user:number){const g=await getGlobalRole(user);return g!=="none"?g:await getRole(peer,user)}
export async function can(peer:number,user:number,min:Role){return rank[await role(peer,user)]>=rank[min]}
export async function setNick(peer:number,user:number,nick:string){await redis.set(chat(peer)+`:nick:${user}`,nick)}
export async function getNick(peer:number,user:number){return await redis.get<string>(chat(peer)+`:nick:${user}`)}
export async function allNicks(peer:number){const keys=await redis.keys(chat(peer)+":nick:*");const out:any[]=[];for(const k of keys){const id=+k.split(":").pop()!;out.push({id,nick:await redis.get<string>(k)})}return out}
export async function getUserIdByNick(peer:number,nick:string){for(const x of await allNicks(peer))if(x.nick?.toLowerCase()===nick.toLowerCase())return x.id;return null}
export async function addBan(scope:string,user:number,by:number,reason:string,until?:number){await redis.hset(r(`ban:${scope}:${user}`),{by:String(by),reason,created:String(Date.now()),until:until?String(until):"0"});await redis.sadd(r(`bannedusers:${scope}`),String(user))}
export async function delBan(scope:string,user:number){await redis.del(r(`ban:${scope}:${user}`));await redis.srem(r(`bannedusers:${scope}`),String(user))}
export async function getBan(scope:string,user:number){const b=await redis.hgetall<Record<string,string>>(r(`ban:${scope}:${user}`));if(!b||!Object.keys(b).length)return null;if(+b.until>0&&+b.until<=Date.now()){await delBan(scope,user);return null}return b}
export async function banScopes(user:number){return (await redis.keys(r(`ban:*:${user}`))).map(k=>k.split(":")[1])}
export async function addMute(peer:number,user:number,until:number,reason:string,by:number){await redis.hset(chat(peer)+`:mute:${user}`,{until:String(until),reason,by:String(by)})}
export async function getMute(peer:number,user:number){const k=chat(peer)+`:mute:${user}`;const x=await redis.hgetall<Record<string,string>>(k);if(!x||!Object.keys(x).length)return null;if(+x.until<=Date.now()){await redis.del(k);return null}return x}
export async function delMute(peer:number,user:number){await redis.del(chat(peer)+`:mute:${user}`)}
export async function timeout(peer:number,on:boolean){await redis.set(chat(peer)+":timeout",on?"1":"0")}
export async function isTimeout(peer:number){return (await redis.get(chat(peer)+":timeout"))==="1"}
export async function addMessage(peer:number,user:number){if(await isTimeout(peer))return;await redis.incr(chat(peer)+`:msg:${user}`);if(await getChatType(peer)==="players")await redis.incr(chat(peer)+`:coins:${user}`)}
export async function balance(peer:number,user:number){return +(await redis.get(chat(peer)+`:coins:${user}`)??0)}
export async function touchMessage(peer:number,user:number,at=Date.now()){await redis.set(chat(peer)+`:last:${user}`,String(at))}
export async function stats(peer:number,user:number){return {messages:+(await redis.get(chat(peer)+`:msg:${user}`)??0),coins:await balance(peer,user),nick:await getNick(peer,user),last:+(await redis.get(chat(peer)+`:last:${user}`)??0)}}
export async function reward(peer:number,user:number){const key=chat(peer)+`:reward:${user}`;if(await redis.exists(key))return null;const n=80+Math.floor(Math.random()*41);await redis.set(key,"1",{ex:10800});await redis.incrby(chat(peer)+`:coins:${user}`,n);return n}
export async function pay(peer:number,from:number,to:number,n:number){if(n<=0)return false;const b=await balance(peer,from);if(b<n)return false;await redis.decrby(chat(peer)+`:coins:${from}`,n);await redis.incrby(chat(peer)+`:coins:${to}`,n);return true}
export async function top(peer:number,global=false){let keys:string[]=[];if(global){keys=await redis.keys(r("chat:*:coins:*"))}else keys=await redis.keys(chat(peer)+":coins:*");const rows:any[]=[];for(const k of keys){const parts=k.split(":");const id=+parts.pop()!;rows.push({id,coins:+(await redis.get(k)??0),peer:parts[2]})}rows.sort((a,b)=>b.coins-a.coins);return rows.slice(0,10)}
