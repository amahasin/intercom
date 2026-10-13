/**
 * InterCom mark: a speech bubble with three dots. Original artwork; tools/scripts/gen-icon.mjs
 * draws the same shape into icon.png and icon.ico, so keep the two in step.
 */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ic-bubble" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect x="2" y="3" width="28" height="22" rx="8" fill="url(#ic-bubble)" />
      <polygon points="6.5,21 15,24.5 5,30" fill="url(#ic-bubble)" />
      <g fill="#ffffff">
        <circle cx="10" cy="14" r="2.2" />
        <circle cx="16" cy="14" r="2.2" />
        <circle cx="22" cy="14" r="2.2" />
      </g>
    </svg>
  );
}
