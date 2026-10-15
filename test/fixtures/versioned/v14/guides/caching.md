# Caching

## Set the cache lifetime

Use `export const revalidate = 3600` to set how long the cache entry lives in version 14.

## Clear the cache

Call `revalidatePath('/posts')` to clear the cache entries in version 14.
