# Local HTTP API

`citepath serve` exposes the same retrieval functions over HTTP for your own apps and scripts.

```sh
citepath serve                 # http://127.0.0.1:7345
citepath serve --port 8080
```

## Endpoints

All endpoints are `GET` and return JSON in the [result contract](result-contract.md).

| Endpoint | Parameters | Returns |
| --- | --- | --- |
| `/v1/search` | `q` (required), `limit`, `source` (repeatable), `path_prefix` | Search response |
| `/v1/passages/{id}` | `neighbors` (0-3) | Passage with context |
| `/v1/sources` | | Sources and sync status |
| `/v1/health` | | `{"status": "ok", "version": "…"}` |

```sh
curl 'http://127.0.0.1:7345/v1/search?q=configure%20authentication&limit=3'
```

Errors use HTTP status codes with a JSON body:

```json
{ "error": { "code": "bad_request", "message": "The search query must not be empty." } }
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `bad_request` | Invalid parameters, unknown source |
| 401 | `unauthorized` | Token required and missing or wrong |
| 403 | `forbidden_host`, `forbidden_origin` | Host or Origin check failed |
| 404 | `not_found` | Unknown endpoint or passage |
| 405 | `method_not_allowed` | Anything but GET or HEAD |

## Security model

- **Loopback only by default.** The server listens on `127.0.0.1` and accepts only `Host` headers for `127.0.0.1`, `localhost`, or `[::1]` on its port. That blocks DNS-rebinding attacks from web pages you visit.
- **No CORS.** No `Access-Control-Allow-*` headers are sent, and requests carrying a cross-origin `Origin` header are rejected, so websites cannot read responses.
- **Read-only.** There are no endpoints that change sources or the index.
- **Other interfaces need a token.** Binding to anything except loopback (for example `--host 0.0.0.0` to serve a team on a LAN) requires a token of at least 16 characters:

  ```sh
  CITEPATH_API_TOKEN="$(openssl rand -hex 24)" citepath serve --host 0.0.0.0
  curl -H "Authorization: Bearer $CITEPATH_API_TOKEN" 'http://server:7345/v1/search?q=deploy'
  ```

  The API does not provide TLS. Put it behind a reverse proxy that terminates TLS when traffic leaves a trusted network.
