import { encodeBase32 } from '@officemesh/protocol';
import { sha256 } from '../identity/crypto.ts';

/**
 * The broadcast channel: one conversation every colleague is in, so a message there reaches
 * everyone on the network. Its ID is the same on every PC (made from a fixed phrase, like a direct
 * chat's from its two people), so no PC has to create it first and none can make a rival.
 *
 * Who is in it is whoever this PC knows of: like a direct chat, the member list is kept locally,
 * not decided by events. An event of the channel is accepted from anyone this PC knows, and sent
 * only to colleagues whose InterCom says (`broadcast.v1`) that it takes part, so older versions
 * are not sent what they would only hold on to.
 */
export const BROADCAST_CONV_ID = encodeBase32(sha256('officemesh/broadcast/v1').subarray(0, 20));

export const BROADCAST_CAP = 'broadcast.v1';

export const isBroadcast = (convId: string): boolean => convId === BROADCAST_CONV_ID;
