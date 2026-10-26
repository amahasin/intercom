/**
 * What is new in each release, in the words an office would use (not the developers'). Shown once
 * after an update, and from Settings > About. Newest first; add the next release's entry at the top
 * when its version is raised (a version with no entry here is simply not announced).
 */
export interface ReleaseNote {
  version: string;
  /** What a colleague can now do. */
  added: Array<{ title: string; text: string }>;
  /** What works better than it did. */
  improved: Array<{ title: string; text: string }>;
  /** What was wrong and is not any more. */
  fixed: Array<{ title: string; text: string }>;
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.18.2',
    added: [
      {
        title: 'Send a whole folder',
        text: 'Use the folder button next to the paperclip, or drag a folder into the chat. It arrives as the folder it is: nothing is zipped, there is no size limit, and you see how far it has come.',
      },
      {
        title: 'New versions download by themselves',
        text: 'When a new version is found it is downloaded in the background, and you are reminded now and then to install it. You can turn this off in Settings > Updates.',
      },
      {
        title: 'Remote help shows every screen',
        text: 'When the other PC has more than one screen, the small picture of them opens by itself and every screen in it is live, so you can see what is happening on the ones you are not looking at.',
      },
    ],
    improved: [
      {
        title: 'The @ menu',
        text: 'Typing @ now opens a clear list of the people you can mention, with their picture, name and job title.',
      },
      {
        title: 'Pinned messages',
        text: 'The pin at the top of a chat fills in and shows how many messages are pinned.',
      },
      {
        title: 'Cards on pictures',
        text: 'A colleague’s card opens when you point at their picture (not their name), anywhere in the app, next to the picture, with the buttons that make sense there: Chat, Profile, or both.',
      },
      {
        title: 'Calls: a tidier window',
        text: 'Recording and sharing are short labels beside the timer, and questions such as someone asking to control your screen are cards in the column at the right. Nothing covers the shared screen any more.',
      },
      {
        title: 'Calls: steadier voice',
        text: 'With noise suppression on High your voice goes out at a steady, comfortable level, you are heard in a loud room, and you do not get louder when a colleague next to you is talking. Keyboard sounds, a door closing, clapping and music from a phone are no longer made louder along with your voice.',
      },
      {
        title: 'A thinner frame',
        text: 'The coloured frame around a screen you are sharing is thinner, in calls and in remote help.',
      },
    ],
    fixed: [
      {
        title: 'Profile on a card',
        text: 'The Profile button on a colleague’s card opened the chat instead. It now opens their profile.',
      },
      {
        title: 'Sending a folder',
        text: 'The person sending a folder now sees how far it has gone, as they do for a single file. Before, only the person receiving it saw the progress.',
      },
    ],
  },
  {
    version: '0.18.1',
    added: [],
    improved: [
      {
        title: 'Choosing a screen in remote help',
        text: 'The picture of the other PC’s screens is compact, with a close button. The screen you chose has a coloured border and the others are no longer greyed out.',
      },
    ],
    fixed: [],
  },
];

/** `[major, minor, patch]` of "1.2.3" (anything after the third number, such as "-beta", is ignored). */
function parts(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** Negative when `a` is older than `b`, 0 when the same, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The notes to show a PC that last saw those of `seen` (empty: it is not known, so the most recent
 * ones) and now runs `current`: every release after `seen` up to `current`, newest first, at most
 * `limit` of them.
 */
export function notesSince(seen: string, current: string, limit = 3): ReleaseNote[] {
  return RELEASE_NOTES.filter(
    (n) =>
      compareVersions(n.version, current) <= 0 && (!seen || compareVersions(n.version, seen) > 0),
  ).slice(0, limit);
}

/** Whether this PC has an update to be told about: it last saw an older version than it runs. */
export function hasUnseen(seen: string, current: string): boolean {
  return current !== '' && compareVersions(seen, current) < 0;
}
