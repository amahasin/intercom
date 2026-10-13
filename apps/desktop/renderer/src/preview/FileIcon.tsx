import {
  Document24Regular,
  DocumentPdf24Regular,
  DocumentTable24Regular,
  DocumentText24Regular,
  Image24Regular,
  MusicNote224Regular,
  SlideText24Regular,
  Video24Regular,
} from '@fluentui/react-icons';
import type { PreviewKind } from './kinds.ts';

const LOOK: Record<PreviewKind, { Icon: typeof Document24Regular; color: string }> = {
  pdf: { Icon: DocumentPdf24Regular, color: '#c4314b' },
  docx: { Icon: DocumentText24Regular, color: '#2b579a' },
  xlsx: { Icon: DocumentTable24Regular, color: '#217346' },
  csv: { Icon: DocumentTable24Regular, color: '#217346' },
  pptx: { Icon: SlideText24Regular, color: '#c43e1c' },
  text: { Icon: DocumentText24Regular, color: '#616161' },
  image: { Icon: Image24Regular, color: '#7a4fa3' },
  video: { Icon: Video24Regular, color: '#0f6cbd' },
  audio: { Icon: MusicNote224Regular, color: '#0f6cbd' },
};

/** The icon of a kind of file, in the colour people know it by. */
export function FileIcon({ kind, size = 24 }: { kind: PreviewKind | undefined; size?: number }) {
  const { Icon, color } = kind ? LOOK[kind] : { Icon: Document24Regular, color: 'currentColor' };
  return <Icon style={{ color, flex: 'none', width: size, height: size }} aria-hidden="true" />;
}
