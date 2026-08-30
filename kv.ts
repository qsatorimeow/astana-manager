// Deno KV storage for Deno Deploy.
// This file keeps the old redis-like interface used by the bot,
// so the rest of the project does not need to know about the migration.

const kv = await Deno.openKv();

function key(...parts: string[]): Deno.KvKey {
  return ["black-helper", ...parts];
}

function encodeRedisKey(redisKey: string): Deno.KvKey {
  return key("value", redisKey);
}

function setMemberKey(setKey: string, member: string): Deno.KvKey {
  return key("set", setKey, member);
}

function listKey(listName: string): Deno.KvKey {
  return key("list", listName);
}

function prefixForSet(setKey: string): Deno.KvKey {
  return key("set", setKey);
}

function prefixForValues(prefix: string): Deno.KvKey {
  return key("value", prefix);
}

function globToPrefix(pattern: string): string {
  // The project only uses simple Redis patterns such as "b2:*".
  const star = pattern.indexOf("*");
  return star >= 0 ? pattern.slice(0, star) : pattern;
}

async function scanPrefix<T>(prefix: Deno.KvKey): Promise<Array<{ key: Deno.KvKey; value: T }>> {
  const result: Array<{ key: Deno.KvKey; value: T }> = [];
  for await (const entry of kv.list<T>({ prefix })) result.push(entry);
  return result;
}

export const redis = {
  async get<T>(redisKey: string): Promise<T | null> {
    const entry = await kv.get<T>(encodeRedisKey(redisKey));
    return entry.value;
  },

  async set<T>(redisKey: string, value: T): Promise<"OK"> {
    await kv.set(encodeRedisKey(redisKey), value);
    return "OK";
  },

  async del(...redisKeys: string[]): Promise<number> {
    let deleted = 0;
    for (const redisKey of redisKeys) {
      // Normal value.
      const valueKey = encodeRedisKey(redisKey);
      const value = await kv.get(valueKey);
      if (value.value !== null) {
        await kv.delete(valueKey);
        deleted++;
        continue;
      }

      // A Redis "set" is represented by multiple KV keys. Delete the whole set
      // when its logical key is passed to del().
      const setEntries = await scanPrefix<boolean>(prefixForSet(redisKey));
      if (setEntries.length > 0) {
        for (const entry of setEntries) await kv.delete(entry.key);
        deleted++;
        continue;
      }

      // A Redis "list" is one KV value.
      const listK = listKey(redisKey);
      const listValue = await kv.get(listK);
      if (listValue.value !== null) {
        await kv.delete(listK);
        deleted++;
      }
    }
    return deleted;
  },

  async exists(redisKey: string): Promise<number> {
    const entry = await kv.get(encodeRedisKey(redisKey));
    return entry.value === null ? 0 : 1;
  },

  async incr(redisKey: string): Promise<number> {
    // Deno KV atomic sum avoids lost increments when several messages arrive together.
    const k = encodeRedisKey(redisKey);
    const result = await kv.atomic().sum(k, 1n).commit();
    if (!result.ok) throw new Error(`Deno KV incr failed for ${redisKey}`);
    const entry = await kv.get<bigint | number | string>(k);
    return Number(entry.value ?? 0);
  },

  async sadd(setKey: string, ...members: string[]): Promise<number> {
    let added = 0;
    for (const member of members) {
      const k = setMemberKey(setKey, member);
      const existing = await kv.get(k);
      if (existing.value === null) {
        await kv.set(k, true);
        added++;
      }
    }
    return added;
  },

  async srem(setKey: string, ...members: string[]): Promise<number> {
    let removed = 0;
    for (const member of members) {
      const k = setMemberKey(setKey, member);
      const existing = await kv.get(k);
      if (existing.value !== null) {
        await kv.delete(k);
        removed++;
      }
    }
    return removed;
  },

  async sismember(setKey: string, member: string): Promise<boolean> {
    const entry = await kv.get(prefixForSet(setKey).concat([member]));
    return entry.value !== null;
  },

  async smembers(setKey: string): Promise<string[]> {
    const entries = await scanPrefix<boolean>(prefixForSet(setKey));
    return entries.map((entry) => String(entry.key[entry.key.length - 1]));
  },

  async rpush(listName: string, ...values: string[]): Promise<number> {
    const k = listKey(listName);
    const current = await kv.get<string[]>(k);
    const list = current.value ?? [];
    list.push(...values);
    await kv.set(k, list);
    return list.length;
  },

  async lrange<T = string>(listName: string, start: number, stop: number): Promise<T[]> {
    const entry = await kv.get<T[]>(listKey(listName));
    const list = entry.value ?? [];
    const normalizedStart = start < 0 ? Math.max(list.length + start, 0) : start;
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return list.slice(normalizedStart, normalizedStop + 1);
  },

  async keys(pattern: string): Promise<string[]> {
    const prefix = globToPrefix(pattern);
    const result = new Set<string>();

    const values = await scanPrefix<unknown>(prefixForValues(prefix));
    for (const entry of values) result.add(String(entry.key[entry.key.length - 1]));

    const sets = await scanPrefix<boolean>(key("set"));
    for (const entry of sets) result.add(String(entry.key[2]));

    const lists = await scanPrefix<unknown>(key("list"));
    for (const entry of lists) result.add(String(entry.key[2]));

    return [...result].filter((k) => {
      if (!pattern.includes("*")) return k === pattern;
      const escaped = pattern.replace(/[.+?^${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(k);
    });
  },
};
