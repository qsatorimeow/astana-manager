import { Redis } from "npm:@upstash/redis@1.34.3";

const url=Deno.env.get("UPSTASH_REDIS_REST_URL");
const token=Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

if(!url||!token){
  console.error("[REDIS] UPSTASH_REDIS_REST_URL или UPSTASH_REDIS_REST_TOKEN не задан.");
}

export const redis=new Redis({
  url:url??"",
  token:token??""
});
