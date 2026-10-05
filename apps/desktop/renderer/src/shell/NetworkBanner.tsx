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
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
  },
});

/** Firewall rules missing, a Public network, or skewed clocks: explain and offer the fix. */
export function NetworkBanner() {
  const styles = useStyles();
  const network = useApp((s) => s.network);
  const [fixing, setFixing] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!network) return null;
  const showFirewall = network.firewall === 'missing';
  const skewed = network.clockSkewPeers;
  if (!showFirewall && !network.publicNetwork && skewed === 0) return null;

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
      {network.publicNetwork && (
        <MessageBar intent="warning" layout="multiline" data-testid="public-network-banner">
          <MessageBarBody>
            <MessageBarTitle>{strings.network.publicTitle}</MessageBarTitle>
            {strings.network.publicBody}
          </MessageBarBody>
          <MessageBarActions>
            <Button onClick={() => void core.invoke('network.openSettings', {})}>
              {strings.network.publicOpen}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {skewed > 0 && (
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
