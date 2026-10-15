# Caching

## Set the cache lifetime

Pass `next: { revalidate: 3600 }` to `fetch` to set how long the cache entry lives in version 15.

## Clear the cache

Call `revalidateTag('posts')` to clear tagged cache entries in version 15.
