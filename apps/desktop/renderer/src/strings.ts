/**
 * Every user-visible string, in one place so other languages (Bangla first) can be added
 * without touching components. English only for now (plan section 16, decision 5).
 */
import type { PresenceState } from '@officemesh/protocol';

export const strings = {
  appName: 'OfficeMesh',
  search: 'Search',
  searchUnavailable: 'Search arrives with message history',
  rail: {
    activity: 'Activity',
    chat: 'Chat',
    teams: 'Teams',
    calendar: 'Calendar',
    calls: 'Calls',
    files: 'Files',
  },
  status: {
    starting: 'Starting…',
    error: 'OfficeMesh could not start',
  },
  presence: {
    available: 'Available',
    busy: 'Busy',
    dnd: 'Do not disturb',
    brb: 'Be right back',
    away: 'Away',
    offline: 'Offline',
  } satisfies Record<PresenceState, string>,
  me: {
    menuLabel: 'Your status and profile',
    autoAway: 'Shown as Away while your PC is idle or locked',
    statusMessage: 'Set status message',
    editProfile: 'Edit profile',
    profileTitle: 'Your profile',
    displayName: 'Display name',
    jobTitle: 'Job title',
    statusPlaceholder: 'What are you working on?',
    save: 'Save',
    cancel: 'Cancel',
    clear: 'Clear',
  },
  listEmpty: {
    activity: 'Mentions, replies and missed calls will show up here.',
    chat: 'Colleagues on your network will appear here.',
    teams: 'Teams you create or join will appear here.',
    calendar: 'Meetings you schedule will appear here.',
    calls: 'Your call history will appear here.',
    files: 'Files shared with you will appear here.',
  },
  chat: {
    find: 'Find a colleague',
    findShortcut: 'Ctrl+N',
    chats: 'Chats',
    people: 'People on your network',
    online: (n: number) => `${n} online`,
    nobody:
      'No colleagues found yet. Anyone on this network who opens OfficeMesh appears here automatically.',
    noMatch: 'Nobody matches that name.',
    noMessagesYet: 'No messages yet',
    you: 'You',
    composePlaceholder: (name: string) => `Message ${name}`,
    send: 'Send',
    sendHint: 'Enter to send, Shift+Enter for a new line',
    startOfChat: (name: string) => `This is the start of your chat with ${name}.`,
    offlineNote: (name: string) =>
      `${name} is offline. Messages you send wait on this PC and are delivered when you are both online.`,
    loadOlder: 'Show earlier messages',
    status: {
      sending: 'Sending…',
      delivered: 'Delivered',
      waiting: (name: string) => `Waiting for ${name} to come online`,
    },
  },
  person: {
    unverifiedBadge: 'New device or unverified',
    unverifiedExplain: (name: string) =>
      `Someone named ${name} was already known on this PC under a different key. This could be a new PC, or someone using the same name. Check the safety phrase with them in person before trusting it.`,
    accept: 'Accept as this person',
    verified: 'Verified',
    markVerified: 'Mark as verified',
    unmarkVerified: 'Remove verification',
    safetyPhrase: 'Safety phrase',
    safetyHelp:
      'Ask them to read out the six words on their own profile card. If they match, mark them verified.',
    chat: 'Chat',
    lastSeen: (when: string) => `Last seen ${when}`,
    jobTitle: 'Job title',
    profileCard: (name: string) => `Profile of ${name}`,
  },
  network: {
    firewallTitle: 'Colleagues may not be able to reach this PC',
    firewallBody:
      'Windows Firewall has no rules for OfficeMesh yet. Fixing it needs administrator approval once.',
    firewallFix: 'Fix',
    firewallFixing: 'Waiting for approval…',
    firewallFailed: 'The firewall rules were not added. You can try again, or ask IT to add them.',
    publicTitle: 'Your network is set to Public',
    publicBody:
      'Windows hides this PC from colleagues on Public networks. In Settings, open Network & internet, select your connection and set Network profile type to Private.',
    publicOpen: 'Open network settings',
    clockTitle: 'Clocks out of step',
    clockBody: (n: number) =>
      `${n === 1 ? 'One colleague’s PC clock differs' : `${n} colleagues’ PC clocks differ`} from this PC’s by more than 30 seconds, so you cannot see each other. Check that Windows sets the time automatically (Settings, Time & language, Date & time) on both PCs.`,
  },
  home: {
    welcome: (name: string) => `Welcome, ${name}`,
    intro:
      'OfficeMesh runs entirely on your office network. There is no server and no sign-in: this PC created your identity, and colleagues will find you automatically.',
    identityHeading: 'Your identity',
    displayName: 'Display name',
    userId: 'User ID',
    safetyPhrase: 'Safety phrase',
    safetyPhraseHelp: 'Compare these six words in person with a colleague to verify each other.',
    profile: 'Profile',
    keyProtection: 'Key protection',
    keyProtectionValue: {
      safeStorage: 'Protected by your Windows account',
      'insecure-test': 'Unprotected (test mode)',
    },
  },
} as const;
