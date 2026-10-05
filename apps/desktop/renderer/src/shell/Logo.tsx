/** OfficeMesh mark: three linked nodes on a rounded tile. Original artwork. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="om-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#om-tile)" />
      <g stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" opacity="0.9">
        <line x1="10" y1="21" x2="16" y2="10" />
        <line x1="16" y1="10" x2="22" y2="21" />
        <line x1="10" y1="21" x2="22" y2="21" />
      </g>
      <g fill="#ffffff">
        <circle cx="16" cy="10" r="3.4" />
        <circle cx="10" cy="21" r="3.4" />
        <circle cx="22" cy="21" r="3.4" />
      </g>
    </svg>
  );
}
