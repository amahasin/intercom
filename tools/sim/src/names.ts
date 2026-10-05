/** Sample display names for simulated colleagues; index-stable so runs are reproducible. */
const FIRST = [
  'Asha',
  'Bilal',
  'Chandni',
  'Dipu',
  'Esha',
  'Farhan',
  'Gita',
  'Hasan',
  'Ishita',
  'Jamal',
  'Kona',
  'Liton',
];
const LAST = [
  'Rahman',
  'Chowdhury',
  'Das',
  'Hossain',
  'Sen',
  'Karim',
  'Roy',
  'Islam',
  'Ahmed',
  'Saha',
];

export function simName(index: number): string {
  const first = FIRST[index % FIRST.length]!;
  const last = LAST[Math.floor(index / FIRST.length + index) % LAST.length]!;
  return `${first} ${last}`;
}

export function simProfile(index: number): string {
  return `peer${String(index).padStart(3, '0')}`;
}
