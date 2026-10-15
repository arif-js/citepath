# Response cache

The client keeps a local cache of GET responses. Cached responses are returned without a network round trip until they expire.

## Cache configuration

Set `cacheTtlSeconds` in the client configuration to control how long a response stays cached. The default is 300 seconds. Set it to 0 to turn the cache off.

```ts
const client = new NimbusClient({ cacheTtlSeconds: 600 });
```

## Clearing the cache

Call `client.clearCache()` after an upload so later reads see the new object. Entries are also evicted when the cache holds more than 1000 responses.
