# VK Administration Bot

Environment variables:
- VK_TOKEN
- VK_CONFIRMATION
- VK_SECRET
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- DEVELOPER_IDS

Deploy on Deno Deploy. The bot uses VK API 5.199 and Upstash Redis.

The bot has separate Redis key prefix `newbot:` so it does not share state with the previous event bot.
