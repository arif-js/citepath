# Webhooks

Nimbus sends webhook events when objects change.

## Object created

Sent after an upload completes.

### Options

Set `includeMetadata: true` to receive object metadata in the payload.

## Object deleted

Sent after an object is deleted.

### Options

Set `includeVersions: true` to receive the deleted version IDs.

## Verifying signatures

Every request carries an `X-Nimbus-Signature` header. Compute an HMAC-SHA256 of the raw
request body with your webhook secret and compare it in constant time before trusting the event.
