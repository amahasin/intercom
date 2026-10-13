import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { strings } from '../strings.ts';
import { inviteToCall, useCall } from './engine.ts';

/**
 * Choose colleagues to bring into the call: from the toolbar's More menu and from the People
 * panel. People already in the call, and those being rung, are not offered again.
 */
export function AddPeopleDialog({ onClose }: { onClose: () => void }) {
  const call = useCall((st) => st.call);
  const [picked, setPicked] = useState<string[]>([]);
  const here = [...(call?.participants.map((p) => p.userId) ?? []), ...(call?.invited ?? [])];
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.calls.addPeople}</DialogTitle>
          <DialogContent>
            <PeoplePicker selected={picked} onChange={setPicked} exclude={here} />
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} data-testid="call-add-cancel">
              {strings.me.cancel}
            </Button>
            <Button
              appearance="primary"
              disabled={picked.length === 0}
              data-testid="call-add-confirm"
              onClick={() => {
                inviteToCall(picked);
                onClose();
              }}
            >
              {strings.groups.add}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
