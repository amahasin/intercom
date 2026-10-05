import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
} from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import type { MsgRef } from '@officemesh/protocol';
import type { MessageView } from '@officemesh/protocol/ipc';
import { act, core } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    minWidth: '260px',
  },
  option: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':disabled': { cursor: 'default' },
  },
  mine: { border: `1px solid ${tokens.colorBrandStroke1}` },
  bar: {
    position: 'absolute',
    inset: '0 auto 0 0',
    background: tokens.colorBrandBackground2,
    zIndex: 0,
  },
  label: { position: 'relative', zIndex: 1 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color: tokens.colorNeutralForeground3,
  },
});

export function PollCard({ message: m }: { message: MessageView }) {
  const s = useStyles();
  const poll = m.poll!;
  const target = { author: m.author, seq: m.seq };
  const convId = m.convId;
  const total = poll.options.reduce((n, o) => n + o.votes, 0);
  const mine = poll.options.flatMap((o, i) => (o.mine ? [i] : []));
  const vote = (i: number) => {
    const choices = poll.multi
      ? mine.includes(i)
        ? mine.filter((c) => c !== i)
        : [...mine, i]
      : [i];
    void act(convId, () => core.invoke('polls.vote', { convId, target, choices }));
  };
  return (
    <div className={s.card} data-testid="poll">
      <Text weight="semibold">{poll.question}</Text>
      {poll.options.map((o, i) => (
        <button
          key={i}
          type="button"
          className={mergeClasses(s.option, o.mine && s.mine)}
          disabled={poll.closed}
          aria-pressed={o.mine}
          onClick={() => vote(i)}
          data-testid={`poll-option-${i}`}
        >
          <span className={s.bar} style={{ width: total ? `${(o.votes / total) * 100}%` : 0 }} />
          <Text className={s.label}>{o.text}</Text>
          <Text className={s.label} size={200} data-testid={`poll-votes-${i}`}>
            {o.votes}
          </Text>
        </button>
      ))}
      <div className={s.footer}>
        <Text size={200}>
          {poll.closed ? `${strings.polls.closed} · ` : ''}
          {strings.polls.votes(poll.voters)}
        </Text>
        {m.mine && !poll.closed && (
          <Button
            size="small"
            appearance="subtle"
            data-testid="poll-close"
            onClick={() => void act(convId, () => core.invoke('polls.close', { convId, target }))}
          >
            {strings.polls.close}
          </Button>
        )}
      </div>
    </div>
  );
}

export function PollDialog({
  convId,
  thread,
  onClose,
}: {
  convId: string;
  thread?: MsgRef | undefined;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [error, setError] = useState<string>();
  const filled = options.map((o) => o.trim()).filter(Boolean);
  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{strings.polls.create}</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 8 }}>
            <Field label={strings.polls.question} validationMessage={error}>
              <Input
                value={question}
                maxLength={300}
                onChange={(_e, d) => setQuestion(d.value)}
                data-testid="poll-question"
              />
            </Field>
            {options.map((o, i) => (
              <Input
                key={i}
                value={o}
                maxLength={100}
                placeholder={strings.polls.option(i + 1)}
                aria-label={strings.polls.option(i + 1)}
                onChange={(_e, d) => setOptions(options.map((x, j) => (j === i ? d.value : x)))}
                data-testid={`poll-option-input-${i}`}
              />
            ))}
            {options.length < 10 && (
              <Button
                appearance="subtle"
                icon={<Add16Regular />}
                onClick={() => setOptions([...options, ''])}
              >
                {strings.polls.addOption}
              </Button>
            )}
            <Checkbox
              checked={multi}
              onChange={(_e, d) => setMulti(d.checked === true)}
              label={strings.polls.multi}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{strings.me.cancel}</Button>
            <Button
              appearance="primary"
              disabled={!question.trim() || filled.length < 2}
              data-testid="poll-post"
              onClick={() =>
                void act(convId, () =>
                  core.invoke('polls.create', {
                    convId,
                    question: question.trim(),
                    options: filled,
                    ...(multi && { multi }),
                    ...(thread && { thread }),
                  }),
                )
                  .then(onClose)
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  )
              }
            >
              {strings.polls.post}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
