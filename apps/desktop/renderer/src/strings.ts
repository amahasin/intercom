/**
 * Every user-visible string, in one place so other languages (Bangla first) can be added
 * without touching components. English only for now (plan section 16, decision 5).
 */
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
  },
  listEmpty: {
    activity: 'Mentions, replies and missed calls will show up here.',
    chat: 'Colleagues on your network will appear here.',
    teams: 'Teams you create or join will appear here.',
    calendar: 'Meetings you schedule will appear here.',
    calls: 'Your call history will appear here.',
    files: 'Files shared with you will appear here.',
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
