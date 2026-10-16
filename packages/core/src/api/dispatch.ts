import type { z } from 'zod';
import {
  ipcCommands,
  isIpcCommandName,
  type IpcCommandName,
  type IpcErrorCode,
  type IpcOutput,
} from '@officemesh/protocol/ipc';
import { NotAvailableError, type Core } from '../core.ts';

export class CommandError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

type Handlers = {
  [N in IpcCommandName]: (
    core: Core,
    input: z.output<(typeof ipcCommands)[N]['input']>,
  ) => IpcOutput<N> | Promise<IpcOutput<N>>;
};

/** The command surface exposed over IPC. Every handler receives schema-validated input. */
const handlers: Handlers = {
  'app.info': (core) => core.appInfo(),
  'identity.get': (core) => core.identityView(),
  'profile.update': (core, edit) => core.updateProfile(edit),
  'presence.get': (core) => core.presenceView(),
  'presence.set': (core, { state }) => core.setPresence(state),
  'people.list': (core) => core.people(),
  'people.setTrust': (core, { userId, ...change }) => core.setPeerTrust(userId, change),
  'conversations.list': (core) => core.conversationList(),
  'conversations.openDirect': (core, { userId }) => core.openDirect(userId),
  'messages.list': (core, { convId, limit, before, rootsOnly }) =>
    core.listMessages(convId, limit, before, rootsOnly),
  'messages.send': (core, { convId, text, ...extra }) => core.sendMessage(convId, text, extra),
  'messages.edit': (core, { convId, target, text, mentions }) =>
    core.editMessage(convId, target, text, mentions),
  'messages.delete': (core, { convId, target }) => core.deleteMessage(convId, target),
  'messages.react': (core, { convId, target, emoji, on }) => core.react(convId, target, emoji, on),
  'messages.pin': (core, { convId, target, on }) => core.pin(convId, target, on),
  'messages.save': (core, { convId, target, on }) => core.save(convId, target, on),
  'messages.forward': (core, { convId, target, toConvId }) =>
    core.forward(convId, target, toConvId),
  'messages.markRead': (core, { convId }) => {
    core.markRead(convId);
    return {};
  },
  'messages.pinned': (core, { convId }) => core.pinnedMessages(convId),
  'messages.saved': (core) => core.savedMessages(),
  'messages.context': (core, { convId, target }) => core.messageContext(convId, target),
  'messages.details': (core, { convId, target }) => core.messageDetails(convId, target),
  'typing.notify': (core, { convId }) => {
    core.sendTyping(convId);
    return {};
  },
  'messages.thread': (core, { convId, target }) => core.threadMessages(convId, target),
  'groups.create': (core, { members, title }) => core.createGroup(members, title),
  'conversations.members': (core, { convId }) => core.conversationMembers(convId),
  'conversations.addMembers': (core, { convId, userIds }) => core.addMembers(convId, userIds),
  'conversations.removeMember': (core, { convId, userId }) => core.removeMember(convId, userId),
  'people.refresh': (core, { userId }) => {
    core.refreshPerson(userId);
    return {};
  },
  'people.hide': (core, { userIds, hidden }) => core.hidePeople(userIds, hidden),
  'conversations.delete': (core, { convId }) => {
    core.deleteChat(convId);
    return {};
  },
  'conversations.leave': (core, { convId }) => {
    core.leave(convId);
    return {};
  },
  'conversations.rename': (core, { convId, title }) => core.renameConversation(convId, title),
  'conversations.setPicture': (core, { convId, picture }) => core.setGroupPicture(convId, picture),
  'teams.list': (core) => core.teams(),
  'teams.create': (core, input) => core.createTeam(input),
  'teams.rename': (core, { teamId, name, description }) =>
    core.renameTeam(teamId, name, description),
  'teams.setRole': (core, { teamId, userId, role }) => core.setTeamRole(teamId, userId, role),
  'teams.discover': (core) => core.discoverTeams(),
  'teams.join': (core, { teamId }) => core.joinTeam(teamId),
  'channels.create': (core, input) => core.createChannel(input),
  'channels.rename': (core, { teamId, channelId, name }) =>
    core.renameChannel(teamId, channelId, name),
  'channels.archive': (core, { teamId, channelId, archived }) =>
    core.archiveChannel(teamId, channelId, archived),
  'assist.list': (core) => core.assistList(),
  'assist.status': (core) => core.assistStatus(),
  'assist.request': (core, { userId, kind }) => core.assistRequest(userId, kind),
  'assist.accept': (core, { sessionId }) => core.assistAccept(sessionId),
  'assist.decline': (core, { sessionId }) => core.assistDecline(sessionId),
  'assist.end': (core, { sessionId }) => core.assistEnd(sessionId),
  'assist.control': (core, { sessionId, on }) => core.assistControl(sessionId, on),
  'assist.dismiss': (core, { sessionId }) => {
    core.assistDismiss(sessionId);
    return {};
  },
  'assist.openSettings': (core) => {
    core.assistOpenSettings();
    return {};
  },
  'polls.create': (core, { convId, ...input }) => core.createPoll(convId, input),
  'polls.vote': (core, { convId, target, choices }) => core.vote(convId, target, choices),
  'polls.close': (core, { convId, target }) => core.closePoll(convId, target),
  'files.list': (core, { convId }) => core.fileList(convId),
  'calls.start': (core, input) => core.startCall(input),
  'calls.accept': (core, { callId, video, how }) => core.acceptCall(callId, video, how),
  'calls.merge': (core, { callId }) => core.mergeCall(callId),
  'calls.resume': (core, { callId }) => core.resumeCall(callId),
  'calls.list': (core) => core.callList(),
  'calls.ended': (core, { callId }) => core.endedCall(callId),
  'calls.decline': (core, { callId }) => {
    core.declineCall(callId);
    return {};
  },
  'calls.hangup': (core, { callId }) => {
    core.hangupCall(callId);
    return {};
  },
  'calls.endForAll': (core, { callId }) => {
    core.endCallForAll(callId);
    return {};
  },
  'calls.invite': (core, { callId, userIds }) => core.inviteToCall(callId, userIds),
  'calls.update': (core, { callId, ...change }) => {
    core.updateCall(callId, change);
    return {};
  },
  'calls.signal': (core, { callId, to, signal }) => {
    core.callSignal(callId, to, signal);
    return {};
  },
  'calls.dropped': (core, { callId, userId }) => {
    core.callDropped(callId, userId);
    return {};
  },
  'calls.current': (core) => core.currentCall(),
  'calls.meetNow': (core, { convId, media, meeting }) => core.meetNow(convId, media, meeting),
  'calls.join': (core, { convId, target }) => core.joinCall(convId, target),
  'calls.react': (core, { callId, emoji }) => {
    core.reactInCall(callId, emoji);
    return {};
  },
  'calls.control': (core, { callId, action, target }) => {
    core.controlCall(callId, action, target ?? null);
    return {};
  },
  'meetings.schedule': (core, input) => core.scheduleMeeting(input),
  'meetings.list': (core, { from, to }) => core.meetingOccurrences(from, to),
  'meetings.update': (core, input) => {
    core.updateMeeting(input);
    return {};
  },
  'meetings.cancel': (core, { convId, target, occurrence }) => {
    core.cancelMeeting(convId, target, occurrence);
    return {};
  },
  'meetings.rsvp': (core, { convId, target, response }) => {
    core.rsvpMeeting(convId, target, response);
    return {};
  },
  'meetings.exportIcs': (core, { convId, target }) => core.exportMeetingIcs(convId, target),
  'recordings.begin': (core, { name, mime }) => core.beginRecording(name, mime),
  'recordings.append': (core, { id, data }) => {
    core.appendRecording(id, data);
    return {};
  },
  'recordings.finish': (core, { id, convId }) => core.finishRecording(id, convId),
  'recordings.abort': (core, { id }) => {
    core.abortRecording(id);
    return {};
  },
  'calls.history': (core) => core.callHistoryItems(),
  'people.activity': (core, { userId }) => core.personActivity(userId),
  'screen.sources': (core) => core.screenSources(),
  'screen.border': (core, { sourceId }) => {
    core.screenBorder(sourceId);
    return {};
  },
  'files.share': (core, input) => core.shareFile(input),
  'files.download': (core, { sha256 }) => core.downloadFile(sha256),
  'files.cancel': (core, { sha256 }) => core.cancelDownload(sha256),
  'files.status': (core, { sha256s }) => sha256s.map((s) => core.fileStatus(s)),
  'files.open': async (core, { sha256 }) => {
    await core.openFile(sha256);
    return {};
  },
  'files.showInFolder': async (core, { sha256 }) => {
    await core.openFile(sha256, true);
    return {};
  },
  'links.preview': (core, { url }) => core.linkPreview(url),
  'search.query': (core, q) => core.search(q),
  'activity.list': (core) => core.activity(),
  'activity.markRead': (core, { ids }) => {
    core.markActivityRead(ids);
    return {};
  },
  'notifications.setLevel': (core, { convId, level }) => core.setNotifyLevel(convId, level),
  'settings.get': (core) => core.settings(),
  'settings.set': (core, change) => core.setSettings(change),
  'profile.setAvatar': (core, { data, mime }) => core.setAvatar(data, mime),
  'ui.state': (core, state) => {
    core.setUiState(state);
    return {};
  },
  'screen.snip': (core) => {
    core.snip();
    return {};
  },
  'network.status': (core) => core.networkStatus(),
  'network.fixFirewall': (core) => core.fixFirewall(),
  'network.openSettings': (core) => {
    core.openNetworkSettings();
    return {};
  },
  'network.addPeer': (core, { address }) => core.addPeer(address),
  'files.pickFolder': (core) => core.pickSaveFolder(),
  'files.showSaveFolder': (core) => {
    core.showSaveFolder();
    return {};
  },
  'calls.relay': (core, { callId, epoch, method, data }) =>
    core.relayRequest(callId, epoch, method, data),
  'profile.export': (core, { passphrase }) => core.exportProfile(passphrase),
  'profile.pickImport': (core) => core.pickProfileFile(),
  'profile.import': (core, { path, passphrase }) => core.importProfile(path, passphrase),
  'app.restart': (core) => {
    core.restart();
    return {};
  },
  'diagnostics.get': (core) => core.diagnostics(),
  'diagnostics.export': (core) => core.exportDiagnostics(),
  'updates.status': (core) => core.updateStatus(),
  'updates.check': (core, { manual }) => core.checkForUpdate(manual === true),
  'updates.install': async (core) => {
    await core.installUpdate();
    return {};
  },
};

export async function dispatchCommand(core: Core, name: string, args: unknown): Promise<unknown> {
  if (!isIpcCommandName(name))
    throw new CommandError('unknown_command', `unknown command: ${name}`);
  const parsed = ipcCommands[name].input.safeParse(args ?? {});
  if (!parsed.success) {
    throw new CommandError(
      'bad_request',
      `invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  const handler = handlers[name] as (core: Core, input: unknown) => unknown;
  try {
    return await handler(core, parsed.data);
  } catch (err) {
    if (err instanceof NotAvailableError) throw new CommandError('bad_request', err.message);
    if (
      err instanceof Error &&
      /empty|unknown conversation|yourself|too large|larger than|ENOENT/.test(err.message)
    ) {
      throw new CommandError('bad_request', err.message);
    }
    throw err;
  }
}
