# Caching

## Set the cache lifetime

Call `cacheLife('hours')` inside a `use cache` function to set how long the cache entry lives.

## Clear the cache

Call `revalidateTag('posts', 'max')` to clear tagged cache entries in the background.
