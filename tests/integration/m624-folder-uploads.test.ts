/**
 * M6.24: the sender's card for a folder. The files of a folder are sent one by one, each under an
 * id nothing on screen knows; `FolderUploads` adds them up per colleague under the folder's id.
 */
import { describe, expect, it } from 'vitest';
import type { FileUpload } from '@officemesh/protocol/ipc';
import type { Clock } from '../../packages/core/src/interfaces.ts';
import { FolderUploads } from '../../packages/core/src/files/folders.ts';

const MB = 1024 * 1024;

function setup(files: Record<string, number>, total: number) {
  let now = 1_000_000;
  const emitted: Array<{ at: number; folder: string; uploads: FileUpload[] }> = [];
  const uploads = new FolderUploads({
    clock: { now: () => now } as unknown as Clock,
    sizeOf: (sha) => files[sha],
    totalOf: () => total,
    emit: (folder, list) => emitted.push({ at: now, folder, uploads: list }),
  });
  /** What a transfer reports for one file and one colleague: `sent` of what they did not have. */
  const report = (file: string, user: string, sent: number, had = 0): FileUpload[] => {
    const size = files[file]!;
    return [{ userId: user, sent, total: size - had, bytesPerSecond: 50 * MB, etaSeconds: 1 }];
  };
  return {
    uploads,
    emitted,
    report,
    advance: (ms: number) => (now += ms),
    last: () => emitted.at(-1)!.uploads,
  };
}

describe('M6.24 a folder going out, as one transfer on its card', () => {
  it('adds up the files being sent at once, to each colleague separately', () => {
    const t = setup({ a: 10 * MB, b: 20 * MB, c: 10 * MB }, 40 * MB);
    t.uploads.note('F', 'a', t.report('a', 'bob', 5 * MB));
    t.advance(300);
    t.uploads.note('F', 'b', t.report('b', 'bob', 5 * MB));
    t.advance(300);
    t.uploads.note('F', 'a', t.report('a', 'carol', 2 * MB));
    const bob = t.last().find((u) => u.userId === 'bob')!;
    const carol = t.last().find((u) => u.userId === 'carol')!;
    // Bob has 5 of "a" and 5 of "b", Carol 2 of "a": out of the whole folder, not of a file.
    expect(bob).toMatchObject({ sent: 10 * MB, total: 40 * MB });
    expect(carol).toMatchObject({ sent: 2 * MB, total: 40 * MB });
    expect(bob.bytesPerSecond).toBeGreaterThanOrEqual(0);
    expect(t.emitted.every((e) => e.folder === 'F')).toBe(true);
  });

  it('counts a finished file once, however many times it reports, and reaches the whole folder', () => {
    const t = setup({ a: 10 * MB, b: 30 * MB }, 40 * MB);
    t.uploads.note('F', 'a', t.report('a', 'bob', 10 * MB));
    t.uploads.note('F', 'a', t.report('a', 'bob', 10 * MB));
    t.advance(300);
    t.uploads.note('F', 'a', t.report('a', 'bob', 10 * MB));
    expect(t.last()[0]).toMatchObject({ sent: 10 * MB });
    t.advance(300);
    t.uploads.note('F', 'b', t.report('b', 'bob', 15 * MB));
    // 10 ms later the last of it goes: shown at once (the card reaches 100 %), not held back.
    const before = t.emitted.length;
    t.advance(10);
    t.uploads.note('F', 'b', t.report('b', 'bob', 30 * MB));
    expect(t.emitted.length).toBe(before + 1);
    expect(t.last()[0]).toMatchObject({ sent: 40 * MB, total: 40 * MB });
  });

  it('counts a thousand tiny files, each finished in one report', () => {
    const files: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) files[`f${i}`] = 100;
    const t = setup(files, 100_000);
    for (let i = 0; i < 1000; i++) {
      t.uploads.note('F', `f${i}`, t.report(`f${i}`, 'bob', 100));
      t.advance(5);
    }
    expect(t.last()[0]).toMatchObject({ sent: 100_000, total: 100_000 });
    // Their late reports (the transfer clears each a few seconds on) do not count them twice.
    t.uploads.note('F', 'f3', t.report('f3', 'bob', 100));
    expect(t.last()[0]!.sent).toBe(100_000);
  });

  it('counts what a colleague already had (a transfer that carries on) as there', () => {
    const t = setup({ a: 10 * MB }, 10 * MB);
    // They had 6 MB: the transfer is of the other 4, and 1 MB of it has gone.
    t.uploads.note('F', 'a', t.report('a', 'bob', 1 * MB, 6 * MB));
    expect(t.last()[0]).toMatchObject({ sent: 7 * MB, total: 10 * MB });
  });

  it('clears the card a few seconds after the last file, and not before', () => {
    const t = setup({ a: 10 * MB, b: 10 * MB }, 20 * MB);
    t.uploads.note('F', 'a', t.report('a', 'bob', 10 * MB));
    // 1 s on, a file of the folder reports nothing for anyone: still going.
    t.advance(1_000);
    t.uploads.note('F', 'b', []);
    expect(t.last()).toHaveLength(1);
    // 3 s after the last byte: they have what they came for.
    t.advance(2_100);
    t.uploads.note('F', 'b', []);
    expect(t.last()).toEqual([]);
    // And the next time starts from nothing.
    t.uploads.note('F', 'a', t.report('a', 'bob', 5 * MB));
    expect(t.last()[0]).toMatchObject({ sent: 5 * MB });
  });

  it('does not report more than four times a second, and never more than the folder holds', () => {
    const t = setup({ a: 100 * MB }, 100 * MB);
    for (let i = 1; i <= 50; i++) {
      t.uploads.note('F', 'a', t.report('a', 'bob', i * MB));
      t.advance(10);
    }
    // 50 reports in half a second: a couple of updates, not fifty.
    expect(t.emitted.length).toBeLessThan(5);
    // A file that went past its size (a late chunk count) is held to the folder's total.
    const u = setup({ a: 10 * MB }, 10 * MB);
    u.uploads.note('F', 'a', [
      { userId: 'bob', sent: 99 * MB, total: 10 * MB, bytesPerSecond: 1, etaSeconds: 1 },
    ]);
    expect(u.last()[0]!.sent).toBeLessThanOrEqual(10 * MB);
  });
});
