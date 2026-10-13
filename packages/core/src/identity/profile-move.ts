/**
 * Moving a profile to another PC (plan section 5, M6): the identity key, the database and
 * the user's avatar, sealed under a passphrase (PBKDF2-HMAC-SHA256, then AES-256-GCM)
 * into one file. Importing stages the profile beside the current one; the swap happens
 * at the next start, before the database opens, and the replaced profile is kept.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { encodeBase64Url, decodeBase64Url, UserId } from '@officemesh/protocol';
import type { KeyProtector } from '../interfaces.ts';
import {
  decryptWithPassphrase,
  encryptWithPassphrase,
  exportPrivateKeyPkcs8,
  importPrivateKeyPkcs8,
  userIdFromSpki,
} from './crypto.ts';
import { KEY_FILE_NAME, writeIdentityKeyFile, type Identity } from './identity.ts';

const MAGIC = 'OFFICEMESH-PROFILE-1\n';
const DB_NAME = 'officemesh.db';
const STAGE_SUFFIX = '.import';
const READY = 'ready.json';
/** A profile file larger than this is refused (a database of millions of messages). */
const MAX_PROFILE_BYTES = 1024 * 1024 * 1024;

const Header = z.object({
  format: z.literal('officemesh-profile'),
  v: z.literal(1),
  userId: UserId,
  displayName: z.string().max(200),
  exportedAt: z.number().int(),
  appVersion: z.string().max(32),
  kdf: z.object({
    alg: z.literal('PBKDF2-HMAC-SHA256'),
    iterations: z.number().int(),
    salt: z.string().max(64),
  }),
  iv: z.string().max(32),
});
type Header = z.infer<typeof Header>;

const Manifest = z.object({
  files: z
    .array(
      z.object({
        role: z.enum(['database', 'key', 'avatar']),
        name: z.string().regex(/^[a-z0-9._-]{1,80}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(8),
});

/** Several files in one buffer: a length-prefixed JSON manifest, then the bytes in order. */
function pack(files: Array<{ role: 'database' | 'key' | 'avatar'; name: string; data: Buffer }>) {
  const manifest = Buffer.from(
    JSON.stringify({
      files: files.map(({ role, name, data }) => ({ role, name, size: data.length })),
    }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  return Buffer.concat([len, manifest, ...files.map((f) => f.data)]);
}

function unpack(buf: Buffer) {
  const len = buf.readUInt32BE(0);
  const manifest = Manifest.parse(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
  let at = 4 + len;
  return manifest.files.map((f) => {
    const data = buf.subarray(at, at + f.size);
    if (data.length !== f.size) throw new Error('profile file is truncated');
    at += f.size;
    return { ...f, data };
  });
}

export interface ExportInput {
  identity: Identity;
  db: Database.Database;
  appVersion: string;
  /** The avatar file for the user's own avatar, if any. */
  avatarPath?: string | undefined;
  passphrase: string;
  outPath: string;
  now: number;
}

/** Write an encrypted profile file to `outPath`. */
export async function exportProfile(input: ExportInput): Promise<void> {
  const snapshot = `${input.outPath}.db-tmp`;
  rmSync(snapshot, { force: true });
  // A consistent copy of the live database (WAL included), compacted.
  input.db.prepare('VACUUM INTO ?').run(snapshot);
  let payload: Buffer;
  try {
    const key = exportPrivateKeyPkcs8(input.identity.privateKey);
    const files: Array<{ role: 'database' | 'key' | 'avatar'; name: string; data: Buffer }> = [
      { role: 'key', name: 'identity.pkcs8', data: key },
      { role: 'database', name: DB_NAME, data: readFileSync(snapshot) },
    ];
    if (input.avatarPath && existsSync(input.avatarPath))
      files.push({
        role: 'avatar',
        name: basename(input.avatarPath).toLowerCase(),
        data: readFileSync(input.avatarPath),
      });
    payload = pack(files);
    key.fill(0);
  } finally {
    rmSync(snapshot, { force: true });
  }
  const headerBase = {
    format: 'officemesh-profile' as const,
    v: 1 as const,
    userId: input.identity.userId,
    displayName: input.identity.profile.displayName,
    exportedAt: input.now,
    appVersion: input.appVersion.slice(0, 32),
  };
  // The header (without the encryption parameters) is authenticated with the content.
  const aad = JSON.stringify(headerBase);
  const sealed = await encryptWithPassphrase(input.passphrase, payload, aad);
  payload.fill(0);
  const header: Header = {
    ...headerBase,
    kdf: {
      alg: 'PBKDF2-HMAC-SHA256',
      iterations: sealed.iterations,
      salt: encodeBase64Url(sealed.salt),
    },
    iv: encodeBase64Url(sealed.iv),
  };
  writeFileSync(
    input.outPath,
    Buffer.concat([Buffer.from(MAGIC), Buffer.from(JSON.stringify(header) + '\n'), sealed.ct]),
  );
}

/** Read and decrypt a profile file; throws a readable message if it cannot. */
async function readProfileFile(path: string, passphrase: string) {
  const raw = readFileSync(path);
  if (raw.length > MAX_PROFILE_BYTES) throw new Error('this profile file is too large');
  if (raw.subarray(0, MAGIC.length).toString('utf8') !== MAGIC)
    throw new Error('this is not an InterCom profile file');
  const nl = raw.indexOf(0x0a, MAGIC.length);
  if (nl < 0) throw new Error('this profile file is damaged');
  const parsed = Header.safeParse(JSON.parse(raw.subarray(MAGIC.length, nl).toString('utf8')));
  if (!parsed.success) throw new Error('this profile file is from a newer app or is damaged');
  const header = parsed.data;
  const { kdf, iv, ...headerBase } = header;
  let payload: Buffer;
  try {
    payload = await decryptWithPassphrase(
      passphrase,
      {
        salt: decodeBase64Url(kdf.salt),
        iterations: kdf.iterations,
        iv: decodeBase64Url(iv),
        ct: raw.subarray(nl + 1),
      },
      JSON.stringify(headerBase),
    );
  } catch {
    throw new Error('wrong passphrase, or the file is damaged');
  }
  return { header, files: unpack(payload) };
}

export function stagePath(dataDir: string): string {
  return `${dataDir}${STAGE_SUFFIX}`;
}

/**
 * Check a profile file and stage it beside `dataDir`: its database, and its key sealed
 * for this PC. Returns who it belongs to. Nothing in use is touched until restart.
 */
export async function stageProfileImport(input: {
  path: string;
  passphrase: string;
  dataDir: string;
  protector: KeyProtector;
}): Promise<{ userId: string; displayName: string }> {
  const { header, files } = await readProfileFile(input.path, input.passphrase);
  const keyFile = files.find((f) => f.role === 'key');
  const dbFile = files.find((f) => f.role === 'database');
  if (!keyFile || !dbFile) throw new Error('this profile file is incomplete');
  const keys = importPrivateKeyPkcs8(keyFile.data);
  if (userIdFromSpki(keys.spki) !== header.userId)
    throw new Error('the key in this file does not match its identity');

  const stage = stagePath(input.dataDir);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    writeFileSync(join(stage, DB_NAME), dbFile.data);
    // The database must belong to the same identity as the key.
    const db = new Database(join(stage, DB_NAME), { readonly: true });
    try {
      const row = db.prepare('SELECT user_id AS userId FROM identity WHERE id = 1').get() as
        { userId: string } | undefined;
      if (row?.userId !== header.userId)
        throw new Error('the history in this file belongs to someone else');
    } finally {
      db.close();
    }
    await writeIdentityKeyFile(join(stage, KEY_FILE_NAME), keys, input.protector);
    for (const f of files.filter((x) => x.role === 'avatar')) {
      mkdirSync(join(stage, 'avatars'), { recursive: true });
      writeFileSync(join(stage, 'avatars', f.name), f.data);
    }
    writeFileSync(
      join(stage, READY),
      JSON.stringify({ userId: header.userId, stagedAt: Date.now() }),
    );
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  keyFile.data.fill(0);
  return { userId: header.userId, displayName: header.displayName };
}

/**
 * At start-up, before the database opens: if an import is staged, move the current
 * profile aside (kept as `<profile>.before-import-<time>`) and put the imported one in
 * its place. Returns true if it swapped.
 */
export function applyStagedImport(dataDir: string, avatarDir: string, now: number): boolean {
  const stage = stagePath(dataDir);
  if (!existsSync(join(stage, READY))) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    return false;
  }
  if (existsSync(dataDir)) renameSync(dataDir, `${dataDir}.before-import-${now}`);
  renameSync(stage, dataDir);
  rmSync(join(dataDir, READY), { force: true });
  const avatars = join(dataDir, 'avatars');
  if (existsSync(avatars)) {
    mkdirSync(avatarDir, { recursive: true });
    for (const name of readdirSync(avatars))
      copyFileSync(join(avatars, name), join(avatarDir, name));
    rmSync(avatars, { recursive: true, force: true });
  }
  return true;
}
