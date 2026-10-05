# OfficeMesh protocol

> Generated from `packages/protocol` by `pnpm docs:protocol`. Do not edit by hand.

Protocol version: **1**

Signed records (beacons, profiles, events) carry `sig`: an ECDSA P-256 / SHA-256 signature in IEEE P1363 form,
base64url, over the canonical JSON of every other field (keys sorted, no whitespace). Receivers verify the
signature over the record exactly as received, then validate it against the schema below.

## 1. Discovery

| Constant | Value |
| --- | --- |
| Multicast group | `239.255.77.77` |
| UDP port | 47800 |
| Default link port (TCP) | 47801 |
| Beacon interval | 5000 ms |
| Offline after | 15000 ms without beacon or link |
| Max clock skew | 30000 ms |
| Max beacon size | 512 bytes |

#### Signed beacon

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "v": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "alive",
        "bye"
      ]
    },
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "pub": {
      "type": "string",
      "minLength": 122,
      "maxLength": 122,
      "pattern": "^[A-Za-z0-9_-]*$"
    },
    "port": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "presence": {
      "type": "string",
      "enum": [
        "available",
        "busy",
        "dnd",
        "brb",
        "away",
        "offline"
      ]
    },
    "profileVer": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "sig": {
      "type": "string",
      "minLength": 86,
      "maxLength": 86,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "v",
    "kind",
    "userId",
    "pub",
    "port",
    "presence",
    "profileVer",
    "ts",
    "sig"
  ]
}
```

## 2. Peer link

| Constant | Value |
| --- | --- |
| Max text frame | 262144 bytes |
| Binary frame header | 24 bytes (16-byte transfer ID, 8-byte big-endian offset) |
| Ping interval | 15000 ms (drop after two missed pongs) |
| Idle close | 600000 ms |
| Reconnect backoff | 1000, 2000, 5000, 15000, 30000 ms |
| Text frames per second | 50 |
| Open file transfers | 64 |
| Events per sync reply | 2000 |
| Ban after a limit is exceeded | 60000 ms |

Capabilities advertised in `hello`: `session.v1`, `profile.v1`

#### Envelope (one per text frame)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "v": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "type": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "replyTo": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "body": {}
  },
  "required": [
    "v",
    "type",
    "id",
    "body"
  ]
}
```

### Message types

| Type | Body defined |
| --- | --- |
| `hello` | yes |
| `ping` | yes |
| `pong` | yes |
| `bye` | yes |
| `profile.get` | yes |
| `profile.data` | yes |
| `avatar.get` | yes |
| `avatar.data` | yes |
| `sync.summary` | not yet |
| `sync.request` | not yet |
| `sync.events` | not yet |
| `event.push` | not yet |
| `event.ack` | not yet |
| `typing` | not yet |
| `presence.detail` | not yet |
| `file.offer` | not yet |
| `file.request` | not yet |
| `file.chunk` | not yet |
| `file.have` | not yet |
| `file.cancel` | not yet |
| `call.invite` | not yet |
| `call.ringing` | not yet |
| `call.accept` | not yet |
| `call.decline` | not yet |
| `call.sdp` | not yet |
| `call.ice` | not yet |
| `call.hangup` | not yet |
| `call.state` | not yet |
| `peers.exchange` | not yet |
| `envelope.store` | not yet |
| `envelope.fetch` | not yet |

#### `hello` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "protocol": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "app": {
      "type": "string",
      "maxLength": 32
    },
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "caps": {
      "maxItems": 64,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 48
      }
    }
  },
  "required": [
    "protocol",
    "app",
    "userId",
    "caps"
  ]
}
```

#### `ping` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ts": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "ts"
  ]
}
```

#### `pong` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ts": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "ts"
  ]
}
```

#### `bye` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "maxLength": 128
    }
  }
}
```

#### `profile.get` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "userId"
  ]
}
```

#### `profile.data` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "profile": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "displayName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "jobTitle": {
          "type": "string",
          "maxLength": 64
        },
        "statusMessage": {
          "type": "string",
          "maxLength": 280
        },
        "statusExpiresAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "avatarHash": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "updatedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sig": {
          "type": "string",
          "minLength": 86,
          "maxLength": 86,
          "pattern": "^[A-Za-z0-9_-]*$"
        }
      },
      "required": [
        "userId",
        "version",
        "displayName",
        "updatedAt",
        "sig"
      ]
    }
  },
  "required": [
    "profile"
  ]
}
```

#### `avatar.get` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "hash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "userId",
    "hash"
  ]
}
```

#### `avatar.data` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "hash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "mime": {
      "type": "string",
      "enum": [
        "image/png",
        "image/jpeg",
        "image/webp"
      ]
    },
    "data": {
      "type": "string",
      "maxLength": 174763,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "hash",
    "mime",
    "data"
  ]
}
```

## 3. Profiles

#### Signed profile

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "version": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "jobTitle": {
      "type": "string",
      "maxLength": 64
    },
    "statusMessage": {
      "type": "string",
      "maxLength": 280
    },
    "statusExpiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "avatarHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "sig": {
      "type": "string",
      "minLength": 86,
      "maxLength": 86,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "userId",
    "version",
    "displayName",
    "updatedAt",
    "sig"
  ]
}
```

## 4. Conversation events

#### Event

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "author": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "seq": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "hlc": {
      "type": "object",
      "properties": {
        "t": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "c": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "t",
        "c"
      ]
    },
    "type": {
      "type": "string",
      "minLength": 1,
      "maxLength": 48
    },
    "body": {},
    "sig": {
      "type": "string",
      "minLength": 86,
      "maxLength": 86,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "convId",
    "author",
    "seq",
    "hlc",
    "type",
    "body",
    "sig"
  ]
}
```

### Event types

| Type | Body defined |
| --- | --- |
| `msg.post` | yes |
| `msg.edit` | not yet |
| `msg.delete` | not yet |
| `msg.react` | not yet |
| `msg.unreact` | not yet |
| `msg.pin` | not yet |
| `msg.unpin` | not yet |
| `msg.read` | not yet |
| `poll.create` | not yet |
| `poll.vote` | not yet |
| `poll.close` | not yet |
| `file.share` | not yet |
| `member.add` | not yet |
| `member.remove` | not yet |
| `member.leave` | not yet |
| `member.role` | not yet |
| `team.create` | not yet |
| `team.rename` | not yet |
| `channel.create` | not yet |
| `channel.rename` | not yet |
| `channel.archive` | not yet |
| `meeting.schedule` | not yet |
| `meeting.update` | not yet |
| `meeting.cancel` | not yet |
| `meeting.rsvp` | not yet |
| `call.started` | not yet |
| `call.ended` | not yet |

#### `msg.post` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 28000
    }
  },
  "required": [
    "text"
  ]
}
```

## 5. Renderer ↔ core IPC

Frames on the renderer's MessagePort. Commands go in as `req`, results come back as `res`, and the core pushes `evt`.

#### Frame

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "const": "req"
        },
        "id": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string",
          "maxLength": 64
        },
        "args": {}
      },
      "required": [
        "kind",
        "id",
        "name",
        "args"
      ]
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "const": "res"
        },
        "id": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "ok": {
          "type": "boolean"
        },
        "result": {},
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "bad_request",
                "unknown_command",
                "not_ready",
                "internal"
              ]
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "kind",
        "id",
        "ok"
      ]
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "const": "evt"
        },
        "name": {
          "type": "string",
          "maxLength": 64
        },
        "payload": {}
      },
      "required": [
        "kind",
        "name",
        "payload"
      ]
    }
  ]
}
```

### Commands

#### `app.info` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `app.info` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "appVersion": {
      "type": "string"
    },
    "protocolVersion": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "profile": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9_-]{0,31}$"
    },
    "dataDir": {
      "type": "string"
    },
    "keyProtection": {
      "type": "string",
      "enum": [
        "safeStorage",
        "insecure-test"
      ]
    }
  },
  "required": [
    "appVersion",
    "protocolVersion",
    "profile",
    "dataDir",
    "keyProtection"
  ]
}
```

#### `identity.get` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `identity.get` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "publicKey": {
      "type": "string",
      "minLength": 122,
      "maxLength": 122,
      "pattern": "^[A-Za-z0-9_-]*$"
    },
    "displayName": {
      "type": "string"
    },
    "jobTitle": {
      "type": "string"
    },
    "statusMessage": {
      "type": "string"
    },
    "profileVersion": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "safetyPhrase": {
      "minItems": 6,
      "maxItems": 6,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "userId",
    "publicKey",
    "displayName",
    "profileVersion",
    "safetyPhrase",
    "createdAt"
  ]
}
```

#### `profile.update` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "jobTitle": {
      "type": "string",
      "maxLength": 64
    },
    "statusMessage": {
      "type": "string",
      "maxLength": 280
    },
    "statusExpiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

#### `profile.update` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "publicKey": {
      "type": "string",
      "minLength": 122,
      "maxLength": 122,
      "pattern": "^[A-Za-z0-9_-]*$"
    },
    "displayName": {
      "type": "string"
    },
    "jobTitle": {
      "type": "string"
    },
    "statusMessage": {
      "type": "string"
    },
    "profileVersion": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "safetyPhrase": {
      "minItems": 6,
      "maxItems": 6,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "userId",
    "publicKey",
    "displayName",
    "profileVersion",
    "safetyPhrase",
    "createdAt"
  ]
}
```

### Events

#### `core.status`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "state": {
      "type": "string",
      "enum": [
        "starting",
        "ready",
        "error"
      ]
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "state"
  ]
}
```

#### `identity.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "publicKey": {
      "type": "string",
      "minLength": 122,
      "maxLength": 122,
      "pattern": "^[A-Za-z0-9_-]*$"
    },
    "displayName": {
      "type": "string"
    },
    "jobTitle": {
      "type": "string"
    },
    "statusMessage": {
      "type": "string"
    },
    "profileVersion": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "safetyPhrase": {
      "minItems": 6,
      "maxItems": 6,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "userId",
    "publicKey",
    "displayName",
    "profileVersion",
    "safetyPhrase",
    "createdAt"
  ]
}
```
