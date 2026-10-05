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

Capabilities advertised in `hello`: `session.v1`, `profile.v1`, `sync.v1`, `typing.v1`, `files.v1`, `teams.v1`

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
| `sync.summary` | yes |
| `sync.request` | not yet |
| `sync.events` | yes |
| `event.push` | yes |
| `event.ack` | yes |
| `typing` | yes |
| `presence.detail` | not yet |
| `file.offer` | not yet |
| `file.request` | yes |
| `file.chunk` | not yet |
| `file.have` | yes |
| `file.manifest` | yes |
| `file.cancel` | yes |
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
| `team.fetch` | yes |
| `team.data` | yes |
| `event.batch` | yes |

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
    },
    "publicTeams": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "teamId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "name": {
            "type": "string",
            "maxLength": 100
          }
        },
        "required": [
          "teamId",
          "name"
        ]
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
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
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

#### `sync.summary` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convs": {
      "maxItems": 5000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "convId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "heads": {
            "type": "object",
            "propertyNames": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            },
            "additionalProperties": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          }
        },
        "required": [
          "convId",
          "heads"
        ]
      }
    }
  },
  "required": [
    "convs"
  ]
}
```

#### `sync.events` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "events": {
      "maxItems": 500,
      "type": "array",
      "items": {}
    },
    "more": {
      "type": "boolean"
    }
  },
  "required": [
    "events"
  ]
}
```

#### `event.push` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "event": {},
    "sentTo": {
      "maxItems": 300,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    }
  },
  "required": [
    "event"
  ]
}
```

#### `event.ack` body

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
    "upto": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "convId",
    "author",
    "upto"
  ]
}
```

#### `typing` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `file.have` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "have": {
      "type": "string",
      "enum": [
        "all",
        "partial",
        "none"
      ]
    },
    "chunks": {
      "type": "string",
      "maxLength": 346,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `file.manifest` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "hashes": {
      "type": "string",
      "maxLength": 87386,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `file.request` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "chunks": {
      "minItems": 1,
      "maxItems": 16,
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2047
      }
    }
  },
  "required": [
    "sha256",
    "chunks"
  ]
}
```

#### `file.cancel` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "chunks": {
      "maxItems": 16,
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `team.fetch` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "teamId"
  ]
}
```

#### `team.data` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "events": {
      "maxItems": 500,
      "type": "array",
      "items": {}
    }
  },
  "required": [
    "teamId",
    "events"
  ]
}
```

#### `event.batch` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pushes": {
      "minItems": 1,
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "event": {},
          "sentTo": {
            "maxItems": 300,
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          }
        },
        "required": [
          "event"
        ]
      }
    }
  },
  "required": [
    "pushes"
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
| `msg.edit` | yes |
| `msg.delete` | yes |
| `msg.react` | yes |
| `msg.unreact` | yes |
| `msg.pin` | yes |
| `msg.unpin` | yes |
| `msg.read` | yes |
| `poll.create` | yes |
| `poll.vote` | yes |
| `poll.close` | yes |
| `file.share` | yes |
| `member.add` | yes |
| `member.remove` | yes |
| `member.leave` | yes |
| `member.role` | yes |
| `group.create` | yes |
| `conv.rename` | yes |
| `team.create` | yes |
| `team.rename` | yes |
| `channel.create` | yes |
| `channel.rename` | yes |
| `channel.archive` | yes |
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
    },
    "mentions": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "urgent": {
      "type": "boolean"
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "maxLength": 64
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        }
      },
      "required": [
        "headline"
      ]
    }
  },
  "required": [
    "text"
  ]
}
```

#### `msg.edit` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 28000
    },
    "mentions": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    }
  },
  "required": [
    "target",
    "text"
  ]
}
```

#### `msg.delete` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "target"
  ]
}
```

#### `msg.react` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "emoji": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32
    }
  },
  "required": [
    "target",
    "emoji"
  ]
}
```

#### `msg.unreact` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "emoji": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32
    }
  },
  "required": [
    "target",
    "emoji"
  ]
}
```

#### `msg.pin` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "target"
  ]
}
```

#### `msg.unpin` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "target"
  ]
}
```

#### `msg.read` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "upto": {
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
    }
  },
  "required": [
    "upto"
  ]
}
```

#### `file.share` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "text": {
      "type": "string",
      "maxLength": 28000
    },
    "mentions": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "urgent": {
      "type": "boolean"
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "file"
  ]
}
```

#### `group.create` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 100
    },
    "members": {
      "minItems": 1,
      "maxItems": 250,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "spki": {
            "type": "string",
            "minLength": 122,
            "maxLength": 122,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "role": {
            "type": "string",
            "enum": [
              "owner",
              "member"
            ]
          }
        },
        "required": [
          "userId",
          "spki",
          "name"
        ]
      }
    },
    "nonce": {
      "type": "string",
      "minLength": 16,
      "maxLength": 44,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "members",
    "nonce"
  ]
}
```

#### `conv.rename` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    }
  },
  "required": [
    "title"
  ]
}
```

#### `team.create` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "visibility": {
      "type": "string",
      "enum": [
        "public",
        "private"
      ]
    },
    "members": {
      "minItems": 1,
      "maxItems": 250,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "spki": {
            "type": "string",
            "minLength": 122,
            "maxLength": 122,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "role": {
            "type": "string",
            "enum": [
              "owner",
              "member"
            ]
          }
        },
        "required": [
          "userId",
          "spki",
          "name"
        ]
      }
    },
    "general": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "nonce": {
      "type": "string",
      "minLength": 16,
      "maxLength": 44,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "name",
    "visibility",
    "members",
    "general",
    "nonce"
  ]
}
```

#### `team.rename` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "maxLength": 500
    }
  },
  "required": [
    "name"
  ]
}
```

#### `member.add` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "members": {
      "minItems": 1,
      "maxItems": 250,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "spki": {
            "type": "string",
            "minLength": 122,
            "maxLength": 122,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "role": {
            "type": "string",
            "enum": [
              "owner",
              "member"
            ]
          }
        },
        "required": [
          "userId",
          "spki",
          "name"
        ]
      }
    },
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "members"
  ]
}
```

#### `member.remove` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "userId"
  ]
}
```

#### `member.leave` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  }
}
```

#### `member.role` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "member"
      ]
    }
  },
  "required": [
    "userId",
    "role"
  ]
}
```

#### `channel.create` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    },
    "description": {
      "type": "string",
      "maxLength": 300
    },
    "private": {
      "type": "boolean"
    },
    "members": {
      "maxItems": 250,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "nonce": {
      "type": "string",
      "minLength": 16,
      "maxLength": 44,
      "pattern": "^[A-Za-z0-9_-]*$"
    }
  },
  "required": [
    "channelId",
    "name",
    "private",
    "nonce"
  ]
}
```

#### `channel.rename` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    }
  },
  "required": [
    "channelId",
    "name"
  ]
}
```

#### `channel.archive` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "channelId",
    "archived"
  ]
}
```

#### `poll.create` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "question": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "options": {
      "minItems": 2,
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      }
    },
    "multi": {
      "type": "boolean"
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "question",
    "options"
  ]
}
```

#### `poll.vote` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "choices": {
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9
      }
    }
  },
  "required": [
    "target",
    "choices"
  ]
}
```

#### `poll.close` body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "target"
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
    "statusExpiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "avatarHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
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
    },
    "avatarHash": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
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
    "statusExpiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "avatarHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
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

#### `presence.get` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `presence.get` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "manual": {
      "type": "string",
      "enum": [
        "available",
        "busy",
        "dnd",
        "brb",
        "away"
      ]
    },
    "effective": {
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
    "idle": {
      "type": "boolean"
    },
    "locked": {
      "type": "boolean"
    }
  },
  "required": [
    "manual",
    "effective",
    "idle",
    "locked"
  ]
}
```

#### `presence.set` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "state": {
      "type": "string",
      "enum": [
        "available",
        "busy",
        "dnd",
        "brb",
        "away"
      ]
    }
  },
  "required": [
    "state"
  ]
}
```

#### `presence.set` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "manual": {
      "type": "string",
      "enum": [
        "available",
        "busy",
        "dnd",
        "brb",
        "away"
      ]
    },
    "effective": {
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
    "idle": {
      "type": "boolean"
    },
    "locked": {
      "type": "boolean"
    }
  },
  "required": [
    "manual",
    "effective",
    "idle",
    "locked"
  ]
}
```

#### `people.list` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `people.list` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
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
      "avatarHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
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
      "online": {
        "type": "boolean"
      },
      "lastSeen": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "trust": {
        "type": "string",
        "enum": [
          "normal",
          "new-device",
          "accepted"
        ]
      },
      "verified": {
        "type": "boolean"
      },
      "safetyPhrase": {
        "minItems": 6,
        "maxItems": 6,
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    },
    "required": [
      "userId",
      "presence",
      "online",
      "lastSeen",
      "trust",
      "verified",
      "safetyPhrase"
    ]
  }
}
```

#### `people.setTrust` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "accept": {
      "type": "boolean"
    },
    "verified": {
      "type": "boolean"
    }
  },
  "required": [
    "userId"
  ]
}
```

#### `people.setTrust` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
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
    "avatarHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
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
    "online": {
      "type": "boolean"
    },
    "lastSeen": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "trust": {
      "type": "string",
      "enum": [
        "normal",
        "new-device",
        "accepted"
      ]
    },
    "verified": {
      "type": "boolean"
    },
    "safetyPhrase": {
      "minItems": 6,
      "maxItems": 6,
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "userId",
    "presence",
    "online",
    "lastSeen",
    "trust",
    "verified",
    "safetyPhrase"
  ]
}
```

#### `conversations.list` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `conversations.list` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "convId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "kind": {
        "type": "string",
        "enum": [
          "direct",
          "group",
          "channel",
          "team"
        ]
      },
      "peerUserId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "title": {
        "type": "string"
      },
      "lastMessage": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "text": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "text",
          "at"
        ]
      },
      "lastActivityAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "unread": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "notify": {
        "type": "string",
        "enum": [
          "all",
          "mentions",
          "muted"
        ]
      },
      "memberCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "teamId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "private": {
        "type": "boolean"
      },
      "archived": {
        "type": "boolean"
      },
      "active": {
        "type": "boolean"
      }
    },
    "required": [
      "convId",
      "kind",
      "title",
      "lastActivityAt",
      "unread",
      "notify",
      "memberCount",
      "active"
    ]
  }
}
```

#### `conversations.openDirect` input

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

#### `conversations.openDirect` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `messages.list` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    },
    "before": {
      "type": "object",
      "properties": {
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
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      },
      "required": [
        "hlc",
        "author"
      ]
    },
    "rootsOnly": {
      "type": "boolean"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `messages.list` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
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
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "text",
          "file"
        ]
      },
      "text": {
        "type": "string"
      },
      "mine": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "sending",
          "waiting",
          "delivered",
          "read"
        ]
      },
      "mentions": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      },
      "mentionsMe": {
        "type": "boolean"
      },
      "urgent": {
        "type": "boolean"
      },
      "edited": {
        "type": "boolean"
      },
      "deleted": {
        "type": "boolean"
      },
      "pinned": {
        "type": "boolean"
      },
      "saved": {
        "type": "boolean"
      },
      "replyTo": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "excerpt": {
            "type": "string"
          },
          "missing": {
            "type": "boolean"
          }
        },
        "required": [
          "author",
          "seq",
          "excerpt",
          "missing"
        ]
      },
      "forwarded": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "from",
          "at"
        ]
      },
      "file": {
        "type": "object",
        "properties": {
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483648
          },
          "mime": {
            "type": "string",
            "maxLength": 127
          },
          "manifest": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "thumb": {
            "type": "string",
            "maxLength": 48000,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "width": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          },
          "height": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          }
        },
        "required": [
          "sha256",
          "name",
          "size",
          "mime",
          "manifest"
        ]
      },
      "preview": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "title": {
            "type": "string",
            "maxLength": 300
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "url",
          "title"
        ]
      },
      "reactions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "emoji": {
              "type": "string"
            },
            "users": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              }
            },
            "mine": {
              "type": "boolean"
            }
          },
          "required": [
            "emoji",
            "users",
            "mine"
          ]
        }
      },
      "kindDetail": {
        "type": "string",
        "enum": [
          "post",
          "file",
          "poll"
        ]
      },
      "thread": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "replyCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "lastReplyAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "announcement": {
        "type": "object",
        "properties": {
          "headline": {
            "type": "string"
          }
        },
        "required": [
          "headline"
        ]
      },
      "poll": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "multi": {
            "type": "boolean"
          },
          "closed": {
            "type": "boolean"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "votes": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "text",
                "votes",
                "mine"
              ]
            }
          },
          "voters": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "question",
          "multi",
          "closed",
          "options",
          "voters"
        ]
      }
    },
    "required": [
      "id",
      "convId",
      "author",
      "seq",
      "hlc",
      "at",
      "kind",
      "text",
      "mine",
      "mentions",
      "mentionsMe",
      "urgent",
      "edited",
      "deleted",
      "pinned",
      "saved",
      "reactions",
      "kindDetail",
      "replyCount"
    ]
  }
}
```

#### `messages.send` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "text": {
      "type": "string",
      "maxLength": 28000
    },
    "mentions": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "urgent": {
      "type": "boolean"
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        }
      },
      "required": [
        "headline"
      ]
    }
  },
  "required": [
    "convId",
    "text"
  ]
}
```

#### `messages.send` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.edit` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "text": {
      "type": "string",
      "maxLength": 28000
    },
    "mentions": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    }
  },
  "required": [
    "convId",
    "target",
    "text"
  ]
}
```

#### `messages.edit` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.delete` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "convId",
    "target"
  ]
}
```

#### `messages.delete` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.react` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "emoji": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32
    },
    "on": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "target",
    "emoji",
    "on"
  ]
}
```

#### `messages.react` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.pin` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "on": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "target",
    "on"
  ]
}
```

#### `messages.pin` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.save` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "on": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "target",
    "on"
  ]
}
```

#### `messages.save` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.forward` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "toConvId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId",
    "target",
    "toConvId"
  ]
}
```

#### `messages.forward` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `messages.markRead` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `messages.markRead` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `messages.pinned` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `messages.pinned` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
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
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "text",
          "file"
        ]
      },
      "text": {
        "type": "string"
      },
      "mine": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "sending",
          "waiting",
          "delivered",
          "read"
        ]
      },
      "mentions": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      },
      "mentionsMe": {
        "type": "boolean"
      },
      "urgent": {
        "type": "boolean"
      },
      "edited": {
        "type": "boolean"
      },
      "deleted": {
        "type": "boolean"
      },
      "pinned": {
        "type": "boolean"
      },
      "saved": {
        "type": "boolean"
      },
      "replyTo": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "excerpt": {
            "type": "string"
          },
          "missing": {
            "type": "boolean"
          }
        },
        "required": [
          "author",
          "seq",
          "excerpt",
          "missing"
        ]
      },
      "forwarded": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "from",
          "at"
        ]
      },
      "file": {
        "type": "object",
        "properties": {
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483648
          },
          "mime": {
            "type": "string",
            "maxLength": 127
          },
          "manifest": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "thumb": {
            "type": "string",
            "maxLength": 48000,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "width": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          },
          "height": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          }
        },
        "required": [
          "sha256",
          "name",
          "size",
          "mime",
          "manifest"
        ]
      },
      "preview": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "title": {
            "type": "string",
            "maxLength": 300
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "url",
          "title"
        ]
      },
      "reactions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "emoji": {
              "type": "string"
            },
            "users": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              }
            },
            "mine": {
              "type": "boolean"
            }
          },
          "required": [
            "emoji",
            "users",
            "mine"
          ]
        }
      },
      "kindDetail": {
        "type": "string",
        "enum": [
          "post",
          "file",
          "poll"
        ]
      },
      "thread": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "replyCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "lastReplyAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "announcement": {
        "type": "object",
        "properties": {
          "headline": {
            "type": "string"
          }
        },
        "required": [
          "headline"
        ]
      },
      "poll": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "multi": {
            "type": "boolean"
          },
          "closed": {
            "type": "boolean"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "votes": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "text",
                "votes",
                "mine"
              ]
            }
          },
          "voters": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "question",
          "multi",
          "closed",
          "options",
          "voters"
        ]
      }
    },
    "required": [
      "id",
      "convId",
      "author",
      "seq",
      "hlc",
      "at",
      "kind",
      "text",
      "mine",
      "mentions",
      "mentionsMe",
      "urgent",
      "edited",
      "deleted",
      "pinned",
      "saved",
      "reactions",
      "kindDetail",
      "replyCount"
    ]
  }
}
```

#### `messages.saved` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `messages.saved` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
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
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "text",
          "file"
        ]
      },
      "text": {
        "type": "string"
      },
      "mine": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "sending",
          "waiting",
          "delivered",
          "read"
        ]
      },
      "mentions": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      },
      "mentionsMe": {
        "type": "boolean"
      },
      "urgent": {
        "type": "boolean"
      },
      "edited": {
        "type": "boolean"
      },
      "deleted": {
        "type": "boolean"
      },
      "pinned": {
        "type": "boolean"
      },
      "saved": {
        "type": "boolean"
      },
      "replyTo": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "excerpt": {
            "type": "string"
          },
          "missing": {
            "type": "boolean"
          }
        },
        "required": [
          "author",
          "seq",
          "excerpt",
          "missing"
        ]
      },
      "forwarded": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "from",
          "at"
        ]
      },
      "file": {
        "type": "object",
        "properties": {
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483648
          },
          "mime": {
            "type": "string",
            "maxLength": 127
          },
          "manifest": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "thumb": {
            "type": "string",
            "maxLength": 48000,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "width": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          },
          "height": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          }
        },
        "required": [
          "sha256",
          "name",
          "size",
          "mime",
          "manifest"
        ]
      },
      "preview": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "title": {
            "type": "string",
            "maxLength": 300
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "url",
          "title"
        ]
      },
      "reactions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "emoji": {
              "type": "string"
            },
            "users": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              }
            },
            "mine": {
              "type": "boolean"
            }
          },
          "required": [
            "emoji",
            "users",
            "mine"
          ]
        }
      },
      "kindDetail": {
        "type": "string",
        "enum": [
          "post",
          "file",
          "poll"
        ]
      },
      "thread": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "replyCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "lastReplyAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "announcement": {
        "type": "object",
        "properties": {
          "headline": {
            "type": "string"
          }
        },
        "required": [
          "headline"
        ]
      },
      "poll": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "multi": {
            "type": "boolean"
          },
          "closed": {
            "type": "boolean"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "votes": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "text",
                "votes",
                "mine"
              ]
            }
          },
          "voters": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "question",
          "multi",
          "closed",
          "options",
          "voters"
        ]
      }
    },
    "required": [
      "id",
      "convId",
      "author",
      "seq",
      "hlc",
      "at",
      "kind",
      "text",
      "mine",
      "mentions",
      "mentionsMe",
      "urgent",
      "edited",
      "deleted",
      "pinned",
      "saved",
      "reactions",
      "kindDetail",
      "replyCount"
    ]
  }
}
```

#### `messages.context` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "convId",
    "target"
  ]
}
```

#### `messages.context` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
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
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "text",
          "file"
        ]
      },
      "text": {
        "type": "string"
      },
      "mine": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "sending",
          "waiting",
          "delivered",
          "read"
        ]
      },
      "mentions": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      },
      "mentionsMe": {
        "type": "boolean"
      },
      "urgent": {
        "type": "boolean"
      },
      "edited": {
        "type": "boolean"
      },
      "deleted": {
        "type": "boolean"
      },
      "pinned": {
        "type": "boolean"
      },
      "saved": {
        "type": "boolean"
      },
      "replyTo": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "excerpt": {
            "type": "string"
          },
          "missing": {
            "type": "boolean"
          }
        },
        "required": [
          "author",
          "seq",
          "excerpt",
          "missing"
        ]
      },
      "forwarded": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "from",
          "at"
        ]
      },
      "file": {
        "type": "object",
        "properties": {
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483648
          },
          "mime": {
            "type": "string",
            "maxLength": 127
          },
          "manifest": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "thumb": {
            "type": "string",
            "maxLength": 48000,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "width": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          },
          "height": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          }
        },
        "required": [
          "sha256",
          "name",
          "size",
          "mime",
          "manifest"
        ]
      },
      "preview": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "title": {
            "type": "string",
            "maxLength": 300
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "url",
          "title"
        ]
      },
      "reactions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "emoji": {
              "type": "string"
            },
            "users": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              }
            },
            "mine": {
              "type": "boolean"
            }
          },
          "required": [
            "emoji",
            "users",
            "mine"
          ]
        }
      },
      "kindDetail": {
        "type": "string",
        "enum": [
          "post",
          "file",
          "poll"
        ]
      },
      "thread": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "replyCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "lastReplyAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "announcement": {
        "type": "object",
        "properties": {
          "headline": {
            "type": "string"
          }
        },
        "required": [
          "headline"
        ]
      },
      "poll": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "multi": {
            "type": "boolean"
          },
          "closed": {
            "type": "boolean"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "votes": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "text",
                "votes",
                "mine"
              ]
            }
          },
          "voters": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "question",
          "multi",
          "closed",
          "options",
          "voters"
        ]
      }
    },
    "required": [
      "id",
      "convId",
      "author",
      "seq",
      "hlc",
      "at",
      "kind",
      "text",
      "mine",
      "mentions",
      "mentionsMe",
      "urgent",
      "edited",
      "deleted",
      "pinned",
      "saved",
      "reactions",
      "kindDetail",
      "replyCount"
    ]
  }
}
```

#### `typing.notify` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `typing.notify` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `files.share` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32767
    },
    "data": {},
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
    },
    "mime": {
      "type": "string",
      "maxLength": 127
    },
    "text": {
      "type": "string",
      "maxLength": 28000
    },
    "mentions": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "urgent": {
      "type": "boolean"
    },
    "thumb": {
      "type": "string",
      "maxLength": 48000
    },
    "width": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `files.share` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `files.download` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `files.download` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "state": {
      "type": "string",
      "enum": [
        "missing",
        "downloading",
        "complete",
        "unavailable",
        "failed"
      ]
    },
    "received": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "size": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "error": {
      "type": "string"
    }
  },
  "required": [
    "sha256",
    "state",
    "received",
    "size"
  ]
}
```

#### `files.cancel` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `files.cancel` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "state": {
      "type": "string",
      "enum": [
        "missing",
        "downloading",
        "complete",
        "unavailable",
        "failed"
      ]
    },
    "received": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "size": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "error": {
      "type": "string"
    }
  },
  "required": [
    "sha256",
    "state",
    "received",
    "size"
  ]
}
```

#### `files.status` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256s": {
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      }
    }
  },
  "required": [
    "sha256s"
  ]
}
```

#### `files.status` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "sha256": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "state": {
        "type": "string",
        "enum": [
          "missing",
          "downloading",
          "complete",
          "unavailable",
          "failed"
        ]
      },
      "received": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "size": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "error": {
        "type": "string"
      }
    },
    "required": [
      "sha256",
      "state",
      "received",
      "size"
    ]
  }
}
```

#### `files.open` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `files.open` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `files.showInFolder` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  },
  "required": [
    "sha256"
  ]
}
```

#### `files.showInFolder` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `links.preview` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "maxLength": 2048
    }
  },
  "required": [
    "url"
  ]
}
```

#### `links.preview` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    {
      "type": "null"
    }
  ]
}
```

#### `search.query` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "maxLength": 200
    },
    "from": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "hasFile": {
      "type": "boolean"
    },
    "after": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "before": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  },
  "required": [
    "text"
  ]
}
```

#### `search.query` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "messages": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "message": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
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
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "kind": {
                "type": "string",
                "enum": [
                  "text",
                  "file"
                ]
              },
              "text": {
                "type": "string"
              },
              "mine": {
                "type": "boolean"
              },
              "status": {
                "type": "string",
                "enum": [
                  "sending",
                  "waiting",
                  "delivered",
                  "read"
                ]
              },
              "mentions": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[a-z2-7]{32}$"
                }
              },
              "mentionsMe": {
                "type": "boolean"
              },
              "urgent": {
                "type": "boolean"
              },
              "edited": {
                "type": "boolean"
              },
              "deleted": {
                "type": "boolean"
              },
              "pinned": {
                "type": "boolean"
              },
              "saved": {
                "type": "boolean"
              },
              "replyTo": {
                "type": "object",
                "properties": {
                  "author": {
                    "type": "string",
                    "pattern": "^[a-z2-7]{32}$"
                  },
                  "seq": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "excerpt": {
                    "type": "string"
                  },
                  "missing": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "author",
                  "seq",
                  "excerpt",
                  "missing"
                ]
              },
              "forwarded": {
                "type": "object",
                "properties": {
                  "from": {
                    "type": "string"
                  },
                  "at": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "from",
                  "at"
                ]
              },
              "file": {
                "type": "object",
                "properties": {
                  "sha256": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{64}$"
                  },
                  "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "size": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 2147483648
                  },
                  "mime": {
                    "type": "string",
                    "maxLength": 127
                  },
                  "manifest": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{64}$"
                  },
                  "thumb": {
                    "type": "string",
                    "maxLength": 48000,
                    "pattern": "^[A-Za-z0-9_-]*$"
                  },
                  "width": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 100000
                  },
                  "height": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 100000
                  }
                },
                "required": [
                  "sha256",
                  "name",
                  "size",
                  "mime",
                  "manifest"
                ]
              },
              "preview": {
                "type": "object",
                "properties": {
                  "url": {
                    "type": "string",
                    "maxLength": 2048
                  },
                  "title": {
                    "type": "string",
                    "maxLength": 300
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 500
                  }
                },
                "required": [
                  "url",
                  "title"
                ]
              },
              "reactions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "emoji": {
                      "type": "string"
                    },
                    "users": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^[a-z2-7]{32}$"
                      }
                    },
                    "mine": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "emoji",
                    "users",
                    "mine"
                  ]
                }
              },
              "kindDetail": {
                "type": "string",
                "enum": [
                  "post",
                  "file",
                  "poll"
                ]
              },
              "thread": {
                "type": "object",
                "properties": {
                  "author": {
                    "type": "string",
                    "pattern": "^[a-z2-7]{32}$"
                  },
                  "seq": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "author",
                  "seq"
                ]
              },
              "replyCount": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "lastReplyAt": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "announcement": {
                "type": "object",
                "properties": {
                  "headline": {
                    "type": "string"
                  }
                },
                "required": [
                  "headline"
                ]
              },
              "poll": {
                "type": "object",
                "properties": {
                  "question": {
                    "type": "string"
                  },
                  "multi": {
                    "type": "boolean"
                  },
                  "closed": {
                    "type": "boolean"
                  },
                  "options": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "text": {
                          "type": "string"
                        },
                        "votes": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "mine": {
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "text",
                        "votes",
                        "mine"
                      ]
                    }
                  },
                  "voters": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "question",
                  "multi",
                  "closed",
                  "options",
                  "voters"
                ]
              }
            },
            "required": [
              "id",
              "convId",
              "author",
              "seq",
              "hlc",
              "at",
              "kind",
              "text",
              "mine",
              "mentions",
              "mentionsMe",
              "urgent",
              "edited",
              "deleted",
              "pinned",
              "saved",
              "reactions",
              "kindDetail",
              "replyCount"
            ]
          },
          "snippet": {
            "type": "string"
          }
        },
        "required": [
          "message",
          "snippet"
        ]
      }
    },
    "tookMs": {
      "type": "number"
    }
  },
  "required": [
    "messages",
    "tookMs"
  ]
}
```

#### `activity.list` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `activity.list` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "mention",
          "reply",
          "reaction"
        ]
      },
      "convId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "author": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "target": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "excerpt": {
        "type": "string"
      },
      "emoji": {
        "type": "string"
      },
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "read": {
        "type": "boolean"
      }
    },
    "required": [
      "id",
      "kind",
      "convId",
      "author",
      "target",
      "excerpt",
      "at",
      "read"
    ]
  }
}
```

#### `activity.markRead` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ids": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      }
    }
  }
}
```

#### `activity.markRead` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `notifications.setLevel` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "level": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    }
  },
  "required": [
    "convId",
    "level"
  ]
}
```

#### `notifications.setLevel` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `settings.get` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `settings.get` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "readReceipts": {
      "type": "boolean"
    },
    "startWithWindows": {
      "type": "boolean"
    }
  },
  "required": [
    "readReceipts",
    "startWithWindows"
  ]
}
```

#### `settings.set` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "readReceipts": {
      "type": "boolean"
    },
    "startWithWindows": {
      "type": "boolean"
    }
  }
}
```

#### `settings.set` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "readReceipts": {
      "type": "boolean"
    },
    "startWithWindows": {
      "type": "boolean"
    }
  },
  "required": [
    "readReceipts",
    "startWithWindows"
  ]
}
```

#### `profile.setAvatar` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "data": {},
    "mime": {
      "type": "string",
      "enum": [
        "image/png",
        "image/jpeg",
        "image/webp"
      ]
    }
  },
  "required": [
    "data",
    "mime"
  ]
}
```

#### `profile.setAvatar` output

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
    "statusExpiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "avatarHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
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

#### `ui.state` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "activeConvId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "windowFocused": {
      "type": "boolean"
    }
  },
  "required": [
    "activeConvId",
    "windowFocused"
  ]
}
```

#### `ui.state` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `screen.snip` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `screen.snip` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `messages.thread` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "convId",
    "target"
  ]
}
```

#### `messages.thread` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
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
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "text",
          "file"
        ]
      },
      "text": {
        "type": "string"
      },
      "mine": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "sending",
          "waiting",
          "delivered",
          "read"
        ]
      },
      "mentions": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      },
      "mentionsMe": {
        "type": "boolean"
      },
      "urgent": {
        "type": "boolean"
      },
      "edited": {
        "type": "boolean"
      },
      "deleted": {
        "type": "boolean"
      },
      "pinned": {
        "type": "boolean"
      },
      "saved": {
        "type": "boolean"
      },
      "replyTo": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "excerpt": {
            "type": "string"
          },
          "missing": {
            "type": "boolean"
          }
        },
        "required": [
          "author",
          "seq",
          "excerpt",
          "missing"
        ]
      },
      "forwarded": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "from",
          "at"
        ]
      },
      "file": {
        "type": "object",
        "properties": {
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483648
          },
          "mime": {
            "type": "string",
            "maxLength": 127
          },
          "manifest": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "thumb": {
            "type": "string",
            "maxLength": 48000,
            "pattern": "^[A-Za-z0-9_-]*$"
          },
          "width": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          },
          "height": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 100000
          }
        },
        "required": [
          "sha256",
          "name",
          "size",
          "mime",
          "manifest"
        ]
      },
      "preview": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "title": {
            "type": "string",
            "maxLength": 300
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "url",
          "title"
        ]
      },
      "reactions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "emoji": {
              "type": "string"
            },
            "users": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              }
            },
            "mine": {
              "type": "boolean"
            }
          },
          "required": [
            "emoji",
            "users",
            "mine"
          ]
        }
      },
      "kindDetail": {
        "type": "string",
        "enum": [
          "post",
          "file",
          "poll"
        ]
      },
      "thread": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "replyCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "lastReplyAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "announcement": {
        "type": "object",
        "properties": {
          "headline": {
            "type": "string"
          }
        },
        "required": [
          "headline"
        ]
      },
      "poll": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "multi": {
            "type": "boolean"
          },
          "closed": {
            "type": "boolean"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "votes": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "text",
                "votes",
                "mine"
              ]
            }
          },
          "voters": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "question",
          "multi",
          "closed",
          "options",
          "voters"
        ]
      }
    },
    "required": [
      "id",
      "convId",
      "author",
      "seq",
      "hlc",
      "at",
      "kind",
      "text",
      "mine",
      "mentions",
      "mentionsMe",
      "urgent",
      "edited",
      "deleted",
      "pinned",
      "saved",
      "reactions",
      "kindDetail",
      "replyCount"
    ]
  }
}
```

#### `groups.create` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "members": {
      "minItems": 1,
      "maxItems": 249,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "title": {
      "type": "string",
      "maxLength": 100
    }
  },
  "required": [
    "members"
  ]
}
```

#### `groups.create` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `conversations.members` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `conversations.members` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "name": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "member"
        ]
      },
      "online": {
        "type": "boolean"
      },
      "avatarHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      }
    },
    "required": [
      "userId",
      "name",
      "role",
      "online"
    ]
  }
}
```

#### `conversations.addMembers` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "userIds": {
      "minItems": 1,
      "maxItems": 249,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    }
  },
  "required": [
    "convId",
    "userIds"
  ]
}
```

#### `conversations.addMembers` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "name": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "member"
        ]
      },
      "online": {
        "type": "boolean"
      },
      "avatarHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      }
    },
    "required": [
      "userId",
      "name",
      "role",
      "online"
    ]
  }
}
```

#### `conversations.removeMember` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId",
    "userId"
  ]
}
```

#### `conversations.removeMember` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "name": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "member"
        ]
      },
      "online": {
        "type": "boolean"
      },
      "avatarHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      }
    },
    "required": [
      "userId",
      "name",
      "role",
      "online"
    ]
  }
}
```

#### `conversations.leave` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `conversations.leave` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

#### `conversations.rename` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    }
  },
  "required": [
    "convId",
    "title"
  ]
}
```

#### `conversations.rename` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `teams.list` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `teams.list` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "teamId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "name": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "visibility": {
        "type": "string",
        "enum": [
          "public",
          "private"
        ]
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "member"
        ]
      },
      "memberCount": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      },
      "channels": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "convId": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            },
            "kind": {
              "type": "string",
              "enum": [
                "direct",
                "group",
                "channel",
                "team"
              ]
            },
            "peerUserId": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            },
            "title": {
              "type": "string"
            },
            "lastMessage": {
              "type": "object",
              "properties": {
                "author": {
                  "type": "string",
                  "pattern": "^[a-z2-7]{32}$"
                },
                "text": {
                  "type": "string"
                },
                "at": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "author",
                "text",
                "at"
              ]
            },
            "lastActivityAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "unread": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "notify": {
              "type": "string",
              "enum": [
                "all",
                "mentions",
                "muted"
              ]
            },
            "memberCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "teamId": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            },
            "private": {
              "type": "boolean"
            },
            "archived": {
              "type": "boolean"
            },
            "active": {
              "type": "boolean"
            }
          },
          "required": [
            "convId",
            "kind",
            "title",
            "lastActivityAt",
            "unread",
            "notify",
            "memberCount",
            "active"
          ]
        }
      }
    },
    "required": [
      "teamId",
      "name",
      "visibility",
      "memberCount",
      "channels"
    ]
  }
}
```

#### `teams.create` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "visibility": {
      "type": "string",
      "enum": [
        "public",
        "private"
      ]
    },
    "members": {
      "maxItems": 249,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    }
  },
  "required": [
    "name",
    "visibility",
    "members"
  ]
}
```

#### `teams.create` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "visibility": {
      "type": "string",
      "enum": [
        "public",
        "private"
      ]
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "member"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "channels": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "convId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "kind": {
            "type": "string",
            "enum": [
              "direct",
              "group",
              "channel",
              "team"
            ]
          },
          "peerUserId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "title": {
            "type": "string"
          },
          "lastMessage": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "text": {
                "type": "string"
              },
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "text",
              "at"
            ]
          },
          "lastActivityAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "unread": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "notify": {
            "type": "string",
            "enum": [
              "all",
              "mentions",
              "muted"
            ]
          },
          "memberCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "teamId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "private": {
            "type": "boolean"
          },
          "archived": {
            "type": "boolean"
          },
          "active": {
            "type": "boolean"
          }
        },
        "required": [
          "convId",
          "kind",
          "title",
          "lastActivityAt",
          "unread",
          "notify",
          "memberCount",
          "active"
        ]
      }
    }
  },
  "required": [
    "teamId",
    "name",
    "visibility",
    "memberCount",
    "channels"
  ]
}
```

#### `teams.rename` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "maxLength": 500
    }
  },
  "required": [
    "teamId",
    "name"
  ]
}
```

#### `teams.rename` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "visibility": {
      "type": "string",
      "enum": [
        "public",
        "private"
      ]
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "member"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "channels": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "convId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "kind": {
            "type": "string",
            "enum": [
              "direct",
              "group",
              "channel",
              "team"
            ]
          },
          "peerUserId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "title": {
            "type": "string"
          },
          "lastMessage": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "text": {
                "type": "string"
              },
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "text",
              "at"
            ]
          },
          "lastActivityAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "unread": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "notify": {
            "type": "string",
            "enum": [
              "all",
              "mentions",
              "muted"
            ]
          },
          "memberCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "teamId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "private": {
            "type": "boolean"
          },
          "archived": {
            "type": "boolean"
          },
          "active": {
            "type": "boolean"
          }
        },
        "required": [
          "convId",
          "kind",
          "title",
          "lastActivityAt",
          "unread",
          "notify",
          "memberCount",
          "active"
        ]
      }
    }
  },
  "required": [
    "teamId",
    "name",
    "visibility",
    "memberCount",
    "channels"
  ]
}
```

#### `teams.setRole` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "member"
      ]
    }
  },
  "required": [
    "teamId",
    "userId",
    "role"
  ]
}
```

#### `teams.setRole` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "name": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "owner",
          "member"
        ]
      },
      "online": {
        "type": "boolean"
      },
      "avatarHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      }
    },
    "required": [
      "userId",
      "name",
      "role",
      "online"
    ]
  }
}
```

#### `teams.discover` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `teams.discover` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "teamId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "name": {
        "type": "string"
      },
      "via": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        }
      }
    },
    "required": [
      "teamId",
      "name",
      "via"
    ]
  }
}
```

#### `teams.join` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "teamId"
  ]
}
```

#### `teams.join` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "visibility": {
      "type": "string",
      "enum": [
        "public",
        "private"
      ]
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "member"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "channels": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "convId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "kind": {
            "type": "string",
            "enum": [
              "direct",
              "group",
              "channel",
              "team"
            ]
          },
          "peerUserId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "title": {
            "type": "string"
          },
          "lastMessage": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "text": {
                "type": "string"
              },
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "text",
              "at"
            ]
          },
          "lastActivityAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "unread": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "notify": {
            "type": "string",
            "enum": [
              "all",
              "mentions",
              "muted"
            ]
          },
          "memberCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "teamId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "private": {
            "type": "boolean"
          },
          "archived": {
            "type": "boolean"
          },
          "active": {
            "type": "boolean"
          }
        },
        "required": [
          "convId",
          "kind",
          "title",
          "lastActivityAt",
          "unread",
          "notify",
          "memberCount",
          "active"
        ]
      }
    }
  },
  "required": [
    "teamId",
    "name",
    "visibility",
    "memberCount",
    "channels"
  ]
}
```

#### `channels.create` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    },
    "description": {
      "type": "string",
      "maxLength": 300
    },
    "private": {
      "type": "boolean"
    },
    "members": {
      "maxItems": 249,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    }
  },
  "required": [
    "teamId",
    "name",
    "private"
  ]
}
```

#### `channels.create` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `channels.rename` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    }
  },
  "required": [
    "teamId",
    "channelId",
    "name"
  ]
}
```

#### `channels.rename` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `channels.archive` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "channelId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "teamId",
    "channelId",
    "archived"
  ]
}
```

#### `channels.archive` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "kind": {
      "type": "string",
      "enum": [
        "direct",
        "group",
        "channel",
        "team"
      ]
    },
    "peerUserId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "title": {
      "type": "string"
    },
    "lastMessage": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "text": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "text",
        "at"
      ]
    },
    "lastActivityAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "unread": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "notify": {
      "type": "string",
      "enum": [
        "all",
        "mentions",
        "muted"
      ]
    },
    "memberCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "teamId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "private": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "convId",
    "kind",
    "title",
    "lastActivityAt",
    "unread",
    "notify",
    "memberCount",
    "active"
  ]
}
```

#### `polls.create` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "question": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "options": {
      "minItems": 2,
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      }
    },
    "multi": {
      "type": "boolean"
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "convId",
    "question",
    "options"
  ]
}
```

#### `polls.create` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `polls.vote` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "choices": {
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9
      }
    }
  },
  "required": [
    "convId",
    "target",
    "choices"
  ]
}
```

#### `polls.vote` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `polls.close` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "convId",
    "target"
  ]
}
```

#### `polls.close` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
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
    "at": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "text",
        "file"
      ]
    },
    "text": {
      "type": "string"
    },
    "mine": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "sending",
        "waiting",
        "delivered",
        "read"
      ]
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      }
    },
    "mentionsMe": {
      "type": "boolean"
    },
    "urgent": {
      "type": "boolean"
    },
    "edited": {
      "type": "boolean"
    },
    "deleted": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "saved": {
      "type": "boolean"
    },
    "replyTo": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "excerpt": {
          "type": "string"
        },
        "missing": {
          "type": "boolean"
        }
      },
      "required": [
        "author",
        "seq",
        "excerpt",
        "missing"
      ]
    },
    "forwarded": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string"
        },
        "at": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "from",
        "at"
      ]
    },
    "file": {
      "type": "object",
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "size": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483648
        },
        "mime": {
          "type": "string",
          "maxLength": 127
        },
        "manifest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "thumb": {
          "type": "string",
          "maxLength": 48000,
          "pattern": "^[A-Za-z0-9_-]*$"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100000
        }
      },
      "required": [
        "sha256",
        "name",
        "size",
        "mime",
        "manifest"
      ]
    },
    "preview": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 2048
        },
        "title": {
          "type": "string",
          "maxLength": 300
        },
        "description": {
          "type": "string",
          "maxLength": 500
        }
      },
      "required": [
        "url",
        "title"
      ]
    },
    "reactions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "emoji": {
            "type": "string"
          },
          "users": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mine": {
            "type": "boolean"
          }
        },
        "required": [
          "emoji",
          "users",
          "mine"
        ]
      }
    },
    "kindDetail": {
      "type": "string",
      "enum": [
        "post",
        "file",
        "poll"
      ]
    },
    "thread": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    },
    "replyCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastReplyAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "announcement": {
      "type": "object",
      "properties": {
        "headline": {
          "type": "string"
        }
      },
      "required": [
        "headline"
      ]
    },
    "poll": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string"
        },
        "multi": {
          "type": "boolean"
        },
        "closed": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "votes": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "mine": {
                "type": "boolean"
              }
            },
            "required": [
              "text",
              "votes",
              "mine"
            ]
          }
        },
        "voters": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "question",
        "multi",
        "closed",
        "options",
        "voters"
      ]
    }
  },
  "required": [
    "id",
    "convId",
    "author",
    "seq",
    "hlc",
    "at",
    "kind",
    "text",
    "mine",
    "mentions",
    "mentionsMe",
    "urgent",
    "edited",
    "deleted",
    "pinned",
    "saved",
    "reactions",
    "kindDetail",
    "replyCount"
  ]
}
```

#### `files.list` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  }
}
```

#### `files.list` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "sha256": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "name": {
        "type": "string"
      },
      "size": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      },
      "mime": {
        "type": "string"
      },
      "convId": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "conversation": {
        "type": "string"
      },
      "author": {
        "type": "string",
        "pattern": "^[a-z2-7]{32}$"
      },
      "at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "message": {
        "type": "object",
        "properties": {
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "author",
          "seq"
        ]
      },
      "state": {
        "type": "string",
        "enum": [
          "missing",
          "downloading",
          "complete",
          "unavailable",
          "failed"
        ]
      }
    },
    "required": [
      "sha256",
      "name",
      "size",
      "mime",
      "convId",
      "conversation",
      "author",
      "at",
      "message",
      "state"
    ]
  }
}
```

#### `network.status` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `network.status` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "firewall": {
      "type": "string",
      "enum": [
        "checking",
        "ok",
        "missing",
        "unknown"
      ]
    },
    "publicNetwork": {
      "type": "boolean"
    },
    "discovery": {
      "type": "string",
      "enum": [
        "off",
        "ok",
        "error"
      ]
    },
    "linkPort": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "onlinePeers": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "clockSkewPeers": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "firewall",
    "publicNetwork",
    "discovery",
    "linkPort",
    "onlinePeers",
    "clockSkewPeers"
  ]
}
```

#### `network.fixFirewall` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `network.fixFirewall` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "firewall": {
      "type": "string",
      "enum": [
        "checking",
        "ok",
        "missing",
        "unknown"
      ]
    },
    "publicNetwork": {
      "type": "boolean"
    },
    "discovery": {
      "type": "string",
      "enum": [
        "off",
        "ok",
        "error"
      ]
    },
    "linkPort": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "onlinePeers": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "clockSkewPeers": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "firewall",
    "publicNetwork",
    "discovery",
    "linkPort",
    "onlinePeers",
    "clockSkewPeers"
  ]
}
```

#### `network.openSettings` input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `network.openSettings` output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
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
    "statusExpiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "avatarHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
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

#### `presence.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "manual": {
      "type": "string",
      "enum": [
        "available",
        "busy",
        "dnd",
        "brb",
        "away"
      ]
    },
    "effective": {
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
    "idle": {
      "type": "boolean"
    },
    "locked": {
      "type": "boolean"
    }
  },
  "required": [
    "manual",
    "effective",
    "idle",
    "locked"
  ]
}
```

#### `people.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "people": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
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
          "avatarHash": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
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
          "online": {
            "type": "boolean"
          },
          "lastSeen": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "trust": {
            "type": "string",
            "enum": [
              "normal",
              "new-device",
              "accepted"
            ]
          },
          "verified": {
            "type": "boolean"
          },
          "safetyPhrase": {
            "minItems": 6,
            "maxItems": 6,
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "userId",
          "presence",
          "online",
          "lastSeen",
          "trust",
          "verified",
          "safetyPhrase"
        ]
      }
    }
  },
  "required": [
    "people"
  ]
}
```

#### `conversations.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "conversations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "convId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "kind": {
            "type": "string",
            "enum": [
              "direct",
              "group",
              "channel",
              "team"
            ]
          },
          "peerUserId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "title": {
            "type": "string"
          },
          "lastMessage": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "text": {
                "type": "string"
              },
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "text",
              "at"
            ]
          },
          "lastActivityAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "unread": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "notify": {
            "type": "string",
            "enum": [
              "all",
              "mentions",
              "muted"
            ]
          },
          "memberCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "teamId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "private": {
            "type": "boolean"
          },
          "archived": {
            "type": "boolean"
          },
          "active": {
            "type": "boolean"
          }
        },
        "required": [
          "convId",
          "kind",
          "title",
          "lastActivityAt",
          "unread",
          "notify",
          "memberCount",
          "active"
        ]
      }
    }
  },
  "required": [
    "conversations"
  ]
}
```

#### `messages.added`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "messages": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
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
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "kind": {
            "type": "string",
            "enum": [
              "text",
              "file"
            ]
          },
          "text": {
            "type": "string"
          },
          "mine": {
            "type": "boolean"
          },
          "status": {
            "type": "string",
            "enum": [
              "sending",
              "waiting",
              "delivered",
              "read"
            ]
          },
          "mentions": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mentionsMe": {
            "type": "boolean"
          },
          "urgent": {
            "type": "boolean"
          },
          "edited": {
            "type": "boolean"
          },
          "deleted": {
            "type": "boolean"
          },
          "pinned": {
            "type": "boolean"
          },
          "saved": {
            "type": "boolean"
          },
          "replyTo": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "seq": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "excerpt": {
                "type": "string"
              },
              "missing": {
                "type": "boolean"
              }
            },
            "required": [
              "author",
              "seq",
              "excerpt",
              "missing"
            ]
          },
          "forwarded": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "from",
              "at"
            ]
          },
          "file": {
            "type": "object",
            "properties": {
              "sha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "size": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483648
              },
              "mime": {
                "type": "string",
                "maxLength": 127
              },
              "manifest": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "thumb": {
                "type": "string",
                "maxLength": 48000,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "width": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 100000
              },
              "height": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 100000
              }
            },
            "required": [
              "sha256",
              "name",
              "size",
              "mime",
              "manifest"
            ]
          },
          "preview": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "maxLength": 2048
              },
              "title": {
                "type": "string",
                "maxLength": 300
              },
              "description": {
                "type": "string",
                "maxLength": 500
              }
            },
            "required": [
              "url",
              "title"
            ]
          },
          "reactions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "emoji": {
                  "type": "string"
                },
                "users": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[a-z2-7]{32}$"
                  }
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "emoji",
                "users",
                "mine"
              ]
            }
          },
          "kindDetail": {
            "type": "string",
            "enum": [
              "post",
              "file",
              "poll"
            ]
          },
          "thread": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "seq": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "seq"
            ]
          },
          "replyCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "lastReplyAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "announcement": {
            "type": "object",
            "properties": {
              "headline": {
                "type": "string"
              }
            },
            "required": [
              "headline"
            ]
          },
          "poll": {
            "type": "object",
            "properties": {
              "question": {
                "type": "string"
              },
              "multi": {
                "type": "boolean"
              },
              "closed": {
                "type": "boolean"
              },
              "options": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "text": {
                      "type": "string"
                    },
                    "votes": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "mine": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "text",
                    "votes",
                    "mine"
                  ]
                }
              },
              "voters": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "question",
              "multi",
              "closed",
              "options",
              "voters"
            ]
          }
        },
        "required": [
          "id",
          "convId",
          "author",
          "seq",
          "hlc",
          "at",
          "kind",
          "text",
          "mine",
          "mentions",
          "mentionsMe",
          "urgent",
          "edited",
          "deleted",
          "pinned",
          "saved",
          "reactions",
          "kindDetail",
          "replyCount"
        ]
      }
    }
  },
  "required": [
    "convId",
    "messages"
  ]
}
```

#### `messages.updated`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "messages": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
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
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "kind": {
            "type": "string",
            "enum": [
              "text",
              "file"
            ]
          },
          "text": {
            "type": "string"
          },
          "mine": {
            "type": "boolean"
          },
          "status": {
            "type": "string",
            "enum": [
              "sending",
              "waiting",
              "delivered",
              "read"
            ]
          },
          "mentions": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z2-7]{32}$"
            }
          },
          "mentionsMe": {
            "type": "boolean"
          },
          "urgent": {
            "type": "boolean"
          },
          "edited": {
            "type": "boolean"
          },
          "deleted": {
            "type": "boolean"
          },
          "pinned": {
            "type": "boolean"
          },
          "saved": {
            "type": "boolean"
          },
          "replyTo": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "seq": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "excerpt": {
                "type": "string"
              },
              "missing": {
                "type": "boolean"
              }
            },
            "required": [
              "author",
              "seq",
              "excerpt",
              "missing"
            ]
          },
          "forwarded": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "from",
              "at"
            ]
          },
          "file": {
            "type": "object",
            "properties": {
              "sha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "size": {
                "type": "integer",
                "minimum": 0,
                "maximum": 2147483648
              },
              "mime": {
                "type": "string",
                "maxLength": 127
              },
              "manifest": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "thumb": {
                "type": "string",
                "maxLength": 48000,
                "pattern": "^[A-Za-z0-9_-]*$"
              },
              "width": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 100000
              },
              "height": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 100000
              }
            },
            "required": [
              "sha256",
              "name",
              "size",
              "mime",
              "manifest"
            ]
          },
          "preview": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "maxLength": 2048
              },
              "title": {
                "type": "string",
                "maxLength": 300
              },
              "description": {
                "type": "string",
                "maxLength": 500
              }
            },
            "required": [
              "url",
              "title"
            ]
          },
          "reactions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "emoji": {
                  "type": "string"
                },
                "users": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[a-z2-7]{32}$"
                  }
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "emoji",
                "users",
                "mine"
              ]
            }
          },
          "kindDetail": {
            "type": "string",
            "enum": [
              "post",
              "file",
              "poll"
            ]
          },
          "thread": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "seq": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "seq"
            ]
          },
          "replyCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "lastReplyAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "announcement": {
            "type": "object",
            "properties": {
              "headline": {
                "type": "string"
              }
            },
            "required": [
              "headline"
            ]
          },
          "poll": {
            "type": "object",
            "properties": {
              "question": {
                "type": "string"
              },
              "multi": {
                "type": "boolean"
              },
              "closed": {
                "type": "boolean"
              },
              "options": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "text": {
                      "type": "string"
                    },
                    "votes": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "mine": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "text",
                    "votes",
                    "mine"
                  ]
                }
              },
              "voters": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "question",
              "multi",
              "closed",
              "options",
              "voters"
            ]
          }
        },
        "required": [
          "id",
          "convId",
          "author",
          "seq",
          "hlc",
          "at",
          "kind",
          "text",
          "mine",
          "mentions",
          "mentionsMe",
          "urgent",
          "edited",
          "deleted",
          "pinned",
          "saved",
          "reactions",
          "kindDetail",
          "replyCount"
        ]
      }
    }
  },
  "required": [
    "convId",
    "messages"
  ]
}
```

#### `network.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "firewall": {
      "type": "string",
      "enum": [
        "checking",
        "ok",
        "missing",
        "unknown"
      ]
    },
    "publicNetwork": {
      "type": "boolean"
    },
    "discovery": {
      "type": "string",
      "enum": [
        "off",
        "ok",
        "error"
      ]
    },
    "linkPort": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "onlinePeers": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "clockSkewPeers": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "firewall",
    "publicNetwork",
    "discovery",
    "linkPort",
    "onlinePeers",
    "clockSkewPeers"
  ]
}
```

#### `typing`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "userId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId",
    "userId"
  ]
}
```

#### `files.progress`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "state": {
      "type": "string",
      "enum": [
        "missing",
        "downloading",
        "complete",
        "unavailable",
        "failed"
      ]
    },
    "received": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "size": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "error": {
      "type": "string"
    }
  },
  "required": [
    "sha256",
    "state",
    "received",
    "size"
  ]
}
```

#### `activity.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "kind": {
            "type": "string",
            "enum": [
              "mention",
              "reply",
              "reaction"
            ]
          },
          "convId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "author": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "target": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string",
                "pattern": "^[a-z2-7]{32}$"
              },
              "seq": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "author",
              "seq"
            ]
          },
          "excerpt": {
            "type": "string"
          },
          "emoji": {
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "read": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "kind",
          "convId",
          "author",
          "target",
          "excerpt",
          "at",
          "read"
        ]
      }
    },
    "unread": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "items",
    "unread"
  ]
}
```

#### `ui.open`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    },
    "target": {
      "type": "object",
      "properties": {
        "author": {
          "type": "string",
          "pattern": "^[a-z2-7]{32}$"
        },
        "seq": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "author",
        "seq"
      ]
    }
  },
  "required": [
    "convId"
  ]
}
```

#### `settings.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "readReceipts": {
      "type": "boolean"
    },
    "startWithWindows": {
      "type": "boolean"
    }
  },
  "required": [
    "readReceipts",
    "startWithWindows"
  ]
}
```

#### `teams.changed`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "teams": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "teamId": {
            "type": "string",
            "pattern": "^[a-z2-7]{32}$"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "visibility": {
            "type": "string",
            "enum": [
              "public",
              "private"
            ]
          },
          "role": {
            "type": "string",
            "enum": [
              "owner",
              "member"
            ]
          },
          "memberCount": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "channels": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "convId": {
                  "type": "string",
                  "pattern": "^[a-z2-7]{32}$"
                },
                "kind": {
                  "type": "string",
                  "enum": [
                    "direct",
                    "group",
                    "channel",
                    "team"
                  ]
                },
                "peerUserId": {
                  "type": "string",
                  "pattern": "^[a-z2-7]{32}$"
                },
                "title": {
                  "type": "string"
                },
                "lastMessage": {
                  "type": "object",
                  "properties": {
                    "author": {
                      "type": "string",
                      "pattern": "^[a-z2-7]{32}$"
                    },
                    "text": {
                      "type": "string"
                    },
                    "at": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "author",
                    "text",
                    "at"
                  ]
                },
                "lastActivityAt": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "unread": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "notify": {
                  "type": "string",
                  "enum": [
                    "all",
                    "mentions",
                    "muted"
                  ]
                },
                "memberCount": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "teamId": {
                  "type": "string",
                  "pattern": "^[a-z2-7]{32}$"
                },
                "private": {
                  "type": "boolean"
                },
                "archived": {
                  "type": "boolean"
                },
                "active": {
                  "type": "boolean"
                }
              },
              "required": [
                "convId",
                "kind",
                "title",
                "lastActivityAt",
                "unread",
                "notify",
                "memberCount",
                "active"
              ]
            }
          }
        },
        "required": [
          "teamId",
          "name",
          "visibility",
          "memberCount",
          "channels"
        ]
      }
    }
  },
  "required": [
    "teams"
  ]
}
```

#### `conversation.reset`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "convId": {
      "type": "string",
      "pattern": "^[a-z2-7]{32}$"
    }
  },
  "required": [
    "convId"
  ]
}
```
