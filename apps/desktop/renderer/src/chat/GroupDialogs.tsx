import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
} from '@fluentui/react-components';
import { PeoplePicker } from '../people/PeoplePicker.tsx';
import { core, putConversation, selectConversation } from '../state.ts';
import { strings } from '../strings.ts';

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const [members, setMembers] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.groups.newGroup}</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 12 }}>
            <Field label={strings.groups.groupName}>
              <Input
                value={title}
                maxLength={100}
                onChange={(_e, d) => setTitle(d.value)}
                data-testid="group-title"
              />
            </Field>
            <Field label={strings.groups.pickPeople}>
              <PeoplePicker selected={members} onChange={setMembers} />
            </Field>
            {error && <Text>{error}</Text>}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={members.length === 0}
              data-testid="group-create"
              onClick={async () => {
                try {
                  const conv = await core.invoke('groups.create', {
                    members,
                    ...(title.trim() && { title: title.trim() }),
                  });
                  putConversation(conv);
                  onClose();
                  await selectConversation(conv.convId);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              {strings.groups.create}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Ask for a single line of text (renaming a chat, channel or team). */
export function TextDialog({
  title,
  label,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  onSubmit: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string>();
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <Field label={label} validationMessage={error}>
              <Input
                value={value}
                maxLength={100}
                onChange={(_e, d) => setValue(d.value)}
                data-testid="text-dialog-input"
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={!value.trim()}
              data-testid="text-dialog-save"
              onClick={() =>
                void onSubmit(value.trim())
                  .then(onClose)
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  )
              }
            >
              {strings.me.save}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
