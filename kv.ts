// Подключение к Upstash Redis.
import { Redis } from "npm:@upstash/redis@1.34.3";

export const redis = new Redis({
  url: Deno.env.get("UPSTASH_REDIS_REST_URL")!,
  token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
});

/**
 * Находит все ключи по шаблону через SCAN (курсор), а не через .keys(),
 * у которого в этой версии клиента ломается разбор шаблона с "*".
 */
export async function scanKeys(pattern: string): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: pattern, count: 200 });
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}
