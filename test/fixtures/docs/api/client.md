# Client API Reference

## createClient(options)

Creates a client. Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `region` | string | `us-east-1` | Region to connect to |
| `maxRetries` | number | `3` | Retries for transient errors |
| `timeoutMs` | number | `30000` | Request timeout in milliseconds |

## client.getUserName(id)

Returns the display name for a user. The `user_profile_id` field in webhook
payloads can be passed directly as `id`.

```ts
const name = await client.getUserName(event.user_profile_id);
```

## Error codes

| Code | Meaning |
| --- | --- |
| `E_RATE_LIMITED` | Too many requests; retry after the delay in `retryAfterMs` |
| `ERR_INVALID_TOKEN` | The API key is missing, expired, or revoked |
| `E_BUCKET_NOT_FOUND` | The bucket does not exist in this region |

## Versioning

This reference covers SDK version 2.3.1. The `config.load()` helper was removed in 2.0.
