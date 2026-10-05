import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeBase64Url, PROTOCOL_VERSION, type ProfileEdit } from '@officemesh/protocol';
import type {
  AppInfo,
  IdentityView,
  IpcEventName,
  IpcEventPayload,
} from '@officemesh/protocol/ipc';
import { editProfile } from './identity/profile.ts';
import { loadOrCreateIdentity, type Identity } from './identity/identity.ts';
import { defaultDisplayName } from './identity/system-name.ts';
import type { Clock, KeyProtector, Logger } from './interfaces.ts';
import { createConsoleLogger, systemClock } from './platform.ts';
import { Store } from './store/store.ts';

export const DATABASE_FILE_NAME = 'officemesh.db';

export interface CoreOptions {
  /** Profile folder: holds the database and the sealed identity key. */
  dataDir: string;
  profile: string;
  appVersion: string;
  keyProtector: KeyProtector;
  clock?: Clock;
  logger?: Logger;
  /** Display name for a new identity; defaults to the Windows account's full name. */
  defaultDisplayName?: () => Promise<string>;
}

export type CoreEventListener = <N extends IpcEventName>(
  name: N,
  payload: IpcEventPayload<N>,
) => void;

/** One peer's core: identity, store and (from M1) discovery, links and sync. */
export class Core {
  readonly identity: Identity;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  private readonly options: CoreOptions;
  private readonly listeners = new Set<CoreEventListener>();
  private closed = false;

  private constructor(
    options: CoreOptions,
    store: Store,
    identity: Identity,
    clock: Clock,
    logger: Logger,
  ) {
    this.options = options;
    this.store = store;
    this.identity = identity;
    this.clock = clock;
    this.logger = logger;
  }

  static async start(options: CoreOptions): Promise<Core> {
    const clock = options.clock ?? systemClock;
    const logger = options.logger ?? createConsoleLogger(`core:${options.profile}`);
    mkdirSync(options.dataDir, { recursive: true });
    const store = Store.open(join(options.dataDir, DATABASE_FILE_NAME));
    try {
      const identity = await loadOrCreateIdentity({
        store,
        dataDir: options.dataDir,
        protector: options.keyProtector,
        clock,
        logger,
        defaultDisplayName: options.defaultDisplayName ?? (() => defaultDisplayName()),
      });
      logger.info('core started', { userId: identity.userId, profile: options.profile });
      return new Core(options, store, identity, clock, logger);
    } catch (err) {
      store.close();
      throw err;
    }
  }

  get userId(): string {
    return this.identity.userId;
  }

  identityView(): IdentityView {
    const { identity } = this;
    const { profile } = identity;
    return {
      userId: identity.userId,
      publicKey: encodeBase64Url(identity.spki),
      displayName: profile.displayName,
      ...(profile.jobTitle !== undefined && { jobTitle: profile.jobTitle }),
      ...(profile.statusMessage !== undefined && { statusMessage: profile.statusMessage }),
      profileVersion: profile.version,
      safetyPhrase: identity.safetyPhrase,
      createdAt: identity.createdAt,
    };
  }

  appInfo(): AppInfo {
    return {
      appVersion: this.options.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      profile: this.options.profile,
      dataDir: this.options.dataDir,
      keyProtection: this.options.keyProtector.scheme,
    };
  }

  updateProfile(edit: ProfileEdit): IdentityView {
    const next = editProfile(
      this.identity.privateKey,
      this.identity.profile,
      edit,
      this.clock.now(),
    );
    this.store.updateProfileJson(JSON.stringify(next));
    this.identity.profile = next;
    const view = this.identityView();
    this.emit('identity.changed', view);
    return view;
  }

  onEvent(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<N extends IpcEventName>(name: N, payload: IpcEventPayload<N>): void {
    for (const listener of this.listeners) {
      try {
        listener(name, payload);
      } catch (err) {
        this.logger.error('event listener failed', { name, err: String(err) });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.store.close();
    this.logger.info('core stopped');
  }
}
