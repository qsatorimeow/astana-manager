import { Redis } from "npm:@upstash/redis@1.34.3";
export const redis = new Redis({url:Deno.env.get("UPSTASH_REDIS_REST_URL")!,token:Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!});
