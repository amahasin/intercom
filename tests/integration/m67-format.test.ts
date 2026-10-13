import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, messageTime } from '../../apps/desktop/renderer/src/format.ts';
import { parseCsv } from '../../apps/desktop/renderer/src/preview/grid.ts';
import { previewKind } from '../../apps/desktop/renderer/src/preview/kinds.ts';

// "Now" is Friday 2 October 2026, 14:30 (local time).
const NOW = new Date(2026, 9, 2, 14, 30).getTime();
const at = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();

describe('M6.7 message times and day lines (as Teams writes them)', () => {
  it('writes only the time for today, the weekday within the week, the date before that', () => {
    expect(messageTime(at(10, 2, 10, 9), NOW)).toMatch(/^10:09\s?AM$/i);
    expect(messageTime(at(10, 1, 11, 48), NOW)).toMatch(/^Thursday,? 11:48\s?AM$/i);
    expect(messageTime(at(9, 29, 12, 8), NOW)).toMatch(/^Tuesday,? 12:08\s?PM$/);
    // Seven days back and more: the date, as in "9/25 12:08 PM".
    expect(messageTime(at(9, 25, 12, 8), NOW)).toMatch(/^9\/25,? 12:08\s?PM$/);
    // Another year gets the year too.
    expect(messageTime(at(12, 30, 9, 5, 2025), NOW)).toMatch(/2025/);
  });

  it('draws the line between days: Today, Yesterday, a weekday, then the long date', () => {
    expect(dayLabel(at(10, 2, 0, 5), NOW)).toBe('Today');
    expect(dayLabel(at(10, 1, 23, 59), NOW)).toBe('Yesterday');
    expect(dayLabel(at(9, 30, 8, 0), NOW)).toBe('Wednesday');
    expect(dayLabel(at(9, 29, 12, 8), NOW)).toBe('Tuesday');
    expect(dayLabel(at(9, 25, 12, 8), NOW)).toMatch(/^Friday,? September 25$/);
    expect(dayLabel(at(12, 30, 9, 5, 2025), NOW)).toMatch(/December 30,? 2025/);
  });

  it('gives every message of a calendar day the same key, whatever the hour', () => {
    expect(dayKey(at(10, 2, 0, 1))).toBe(dayKey(at(10, 2, 23, 59)));
    expect(dayKey(at(10, 2, 23, 59))).not.toBe(dayKey(at(10, 3, 0, 1)));
  });
});

describe('M6.7 CSV', () => {
  it('reads quotes, escaped quotes, commas and line breaks inside a field', () => {
    const sheet = parseCsv('Name,Note\r\n"Bob, Jr.","He said ""hi""\nand left"\nAlice,ok\n');
    expect(sheet.rows).toEqual([
      ['Name', 'Note'],
      ['Bob, Jr.', 'He said "hi"\nand left'],
      ['Alice', 'ok'],
    ]);
    expect(sheet.truncated).toBe(false);
  });

  it('works out semicolon and tab separators, and keeps a last row with no line break', () => {
    expect(parseCsv('a;b;c\n1;2;3').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a\tb\n1\t2\n').rows[1]).toEqual(['1', '2']);
    expect(parseCsv('a,b\n1,2', true).rows[0]).toEqual(['a,b']);
  });

  it('stops at 2000 rows and says so', () => {
    const sheet = parseCsv(Array.from({ length: 2500 }, (_, i) => `r${i},x`).join('\n'));
    expect(sheet.rows).toHaveLength(2000);
    expect(sheet.truncated).toBe(true);
  });
});

describe('M6.7 which files the viewer shows', () => {
  const kind = (name: string, mime = 'application/octet-stream') => previewKind({ name, mime });

  it('goes by the name first, because senders often give a generic type', () => {
    expect(kind('Report.PDF')).toBe('pdf');
    expect(kind('notes.docx')).toBe('docx');
    expect(kind('budget.xlsx')).toBe('xlsx');
    expect(kind('deck.pptx')).toBe('pptx');
    expect(kind('people.csv')).toBe('csv');
    expect(kind('main.ts')).toBe('text');
    expect(kind('photo.JPG')).toBe('image');
    expect(kind('song.mp3')).toBe('audio');
  });

  it('falls back to the type, and leaves the rest to the PC', () => {
    expect(kind('download', 'application/pdf')).toBe('pdf');
    expect(kind('download', 'image/png')).toBe('image');
    expect(kind('setup.exe')).toBeUndefined();
    expect(kind('archive.zip', 'application/zip')).toBeUndefined();
    // A video the page cannot play is not previewed.
    expect(kind('clip.mp4', 'video/x-matroska')).toBeUndefined();
    expect(kind('clip.mp4', 'video/mp4')).toBe('video');
  });
});
