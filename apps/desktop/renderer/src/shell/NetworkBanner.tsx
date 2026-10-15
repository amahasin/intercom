import { useState } from 'react';
import {
  Button,
  makeStyles,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import { core, useApp } from '../state.ts';
import { useExpired } from './ephemeral.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
  },
});

/**
 * Firewall rules missing for the network this PC is on, or skewed clocks: explain and offer
 * the fix. A Public network is not a problem here: the rules cover every network profile,
 * so nobody is asked to reclassify their network just to use a LAN messenger.
 */
export function NetworkBanner() {
  const styles = useStyles();
  const network = useApp((s) => s.network);
  const [fixing, setFixing] = useState(false);
  const [failed, setFailed] = useState(false);
  const showFirewall = network?.firewall === 'missing';
  const skewed = network?.clockSkewPeers ?? 0;
  // The clock note only informs, so it goes after a few seconds (and returns if the number changes).
  const skewGone = useExpired(skewed > 0 ? `skew:${skewed}` : undefined);
  if (!network) return null;
  if (!showFirewall && (skewed === 0 || skewGone)) return null;

  const fix = async () => {
    setFixing(true);
    setFailed(false);
    try {
      const status = await core.invoke('network.fixFirewall', {});
      useApp.setState({ network: status });
      if (status.firewall !== 'ok') setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className={styles.stack}>
      {showFirewall && (
        <MessageBar intent="warning" layout="multiline" data-testid="firewall-banner">
          <MessageBarBody>
            <MessageBarTitle>{strings.network.firewallTitle}</MessageBarTitle>
            {failed ? strings.network.firewallFailed : strings.network.firewallBody}
          </MessageBarBody>
          <MessageBarActions>
            <Button
              appearance="primary"
              disabled={fixing}
              onClick={() => void fix()}
              data-testid="firewall-fix"
            >
              {fixing ? strings.network.firewallFixing : strings.network.firewallFix}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {skewed > 0 && !skewGone && (
        <MessageBar intent="info" layout="multiline" data-testid="clock-skew-banner">
          <MessageBarBody>
            <MessageBarTitle>{strings.network.clockTitle}</MessageBarTitle>
            {strings.network.clockBody(skewed)}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
