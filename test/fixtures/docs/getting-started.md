---
title: Getting Started with Nimbus
description: Install the Nimbus SDK and make your first request.
---

# Getting Started

Nimbus is a fictional cloud storage SDK used as Citepath's test corpus.

## Installation

Install the SDK from npm. Nimbus requires Node.js 22.13 or later.

```bash
npm install nimbus-sdk
```

## Configure authentication

Nimbus reads your API key from the `NIMBUS_API_KEY` environment variable.
You can also log in once with the CLI, which stores a token in your home directory:

```bash
nimbus login --token "$NIMBUS_API_KEY"
```

Never commit API keys to version control. Rotate a leaked key from the dashboard.

## Make your first request

Create a client and list your buckets:

```js
import { createClient } from 'nimbus-sdk';

const client = createClient({ region: 'eu-west-1' });
const buckets = await client.listBuckets();
```
