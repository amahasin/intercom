/**
 * A person's picture that opens large when it is clicked: the avatar as it is everywhere, and, in
 * a dialog, the picture itself at the size it was kept (256 px). Without a picture there is nothing
 * to enlarge, so the initials are shown as they are.
 */
import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
  type AvatarProps,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { avatarSrc } from '../state.ts';
import { strings } from '../strings.ts';

const useStyles = makeStyles({
  button: {
    border: 'none',
    background: 'transparent',
    padding: 0,
    borderRadius: '50%',
    cursor: 'zoom-in',
    display: 'inline-flex',
    flexShrink: 0,
  },
  surface: { width: 'min(420px, 90vw)', maxWidth: '90vw' },
  picture: {
    display: 'block',
    width: '100%',
    aspectRatio: '1 / 1',
    objectFit: 'contain',
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground3,
  },
});

export function EnlargeablePicture({
  name,
  avatarHash,
  ...avatar
}: { name: string; avatarHash: string | undefined } & Omit<AvatarProps, 'name' | 'image'>) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const image = avatarSrc(avatarHash);
  if (!image) return <Avatar name={name} color="colorful" {...avatar} />;
  return (
    <Dialog open={open} onOpenChange={(_e, d) => setOpen(d.open)}>
      <button
        type="button"
        className={styles.button}
        aria-label={strings.person.enlarge(name)}
        onClick={() => setOpen(true)}
        data-testid="enlarge-picture"
      >
        <Avatar name={name} color="colorful" image={image} {...avatar} />
      </button>
      <DialogSurface className={styles.surface} data-testid="enlarged-picture">
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label={strings.person.closePicture}
                icon={<Dismiss20Regular />}
                onClick={() => setOpen(false)}
                data-testid="enlarged-picture-close"
              />
            }
          >
            {name}
          </DialogTitle>
          <DialogContent>
            <img
              className={styles.picture}
              src={image.src}
              alt={strings.person.pictureOf(name)}
              data-testid="enlarged-picture-image"
            />
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
