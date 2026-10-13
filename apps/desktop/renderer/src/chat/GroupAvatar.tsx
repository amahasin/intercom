import { Avatar } from '@fluentui/react-components';

/** A group's picture (a small JPEG that travels in its log), or its initials. */
export function groupPictureSrc(picture: string | undefined): { src: string } | undefined {
  return picture ? { src: `data:image/jpeg;base64,${picture}` } : undefined;
}

export function GroupAvatar({
  title,
  picture,
  size,
}: {
  title: string;
  picture: string | undefined;
  size: 24 | 28 | 32 | 36 | 40 | 48;
}) {
  return (
    <Avatar
      name={title}
      size={size}
      color="colorful"
      shape="square"
      image={groupPictureSrc(picture)}
      data-testid="group-avatar"
    />
  );
}

/**
 * Square-crop a chosen picture and shrink it to 128 x 128 on this PC: a group's picture is carried
 * in every member's copy of its log, so it has to stay small (a few KB of JPEG).
 */
export async function groupPictureFrom(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(128, 128);
  canvas
    .getContext('2d')!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      128,
      128,
    );
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
