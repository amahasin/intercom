import { PresenceBadge } from '@fluentui/react-components';
import type { PresenceState } from '@officemesh/protocol';
import { presenceBadge } from '../format.ts';
import { strings } from '../strings.ts';

/**
 * A status dot that reads at a glance and in a screen reader: green for available, red for
 * busy, red with a bar for do not disturb, yellow for away and be right back, grey for
 * offline. The same dot is used in the status menu, headers and profile cards, so one
 * status always looks the same.
 */
export function PresenceDot({
  state,
  size = 'small',
}: {
  state: PresenceState;
  size?: 'tiny' | 'extra-small' | 'small' | 'medium' | 'large' | 'extra-large';
}) {
  const badge = presenceBadge(state);
  return (
    <PresenceBadge
      status={badge.status}
      size={size}
      aria-label={strings.presence[state]}
      data-testid="presence-dot"
      data-presence={state}
    />
  );
}
