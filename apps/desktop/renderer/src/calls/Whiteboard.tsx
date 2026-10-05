import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  Input,
  makeStyles,
  mergeClasses,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
  tokens,
} from '@fluentui/react-components';
import {
  Circle20Regular,
  Delete20Regular,
  Edit20Regular,
  ImageArrowForward20Regular,
  Note20Regular,
  RectangleLandscape20Regular,
  TextT20Regular,
} from '@fluentui/react-icons';
import { core } from '../state.ts';
import { strings } from '../strings.ts';
import {
  addShape,
  beginStroke,
  clearWhiteboard,
  setWhiteboardOpen,
  useWhiteboard,
  whiteboardItems,
  type WhiteboardItem,
  type WhiteboardTool,
} from './whiteboard.ts';

/** The board's coordinate space; the canvas scales it to fit. */
const BOARD_W = 1600;
const BOARD_H = 900;
const COLORS = ['#242424', '#c4314b', '#0f6cbd', '#107c10', '#ca5010'];

const useStyles = makeStyles({
  root: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    gap: tokens.spacingVerticalS,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    background: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: '2px 8px',
  },
  canvasWrap: { flex: 1, minHeight: 0, display: 'grid', placeItems: 'center' },
  canvas: {
    maxWidth: '100%',
    maxHeight: '100%',
    aspectRatio: '16 / 9',
    background: '#ffffff',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'crosshair',
    touchAction: 'none',
  },
  swatch: {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    border: '2px solid transparent',
    cursor: 'pointer',
  },
  chosen: { border: `2px solid ${tokens.colorNeutralForeground1}` },
});

/** Draw the board deterministically from the shared document, in its order. */
export function renderBoard(ctx: CanvasRenderingContext2D, items: WhiteboardItem[]): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const it of items) {
    ctx.strokeStyle = it.color;
    ctx.fillStyle = it.color;
    ctx.lineWidth = 4;
    if (it.kind === 'stroke') {
      ctx.beginPath();
      for (let i = 0; i + 1 < it.points.length; i += 2) {
        if (i === 0) ctx.moveTo(it.points[0]!, it.points[1]!);
        else ctx.lineTo(it.points[i]!, it.points[i + 1]!);
      }
      if (it.points.length === 2) ctx.lineTo(it.points[0]! + 0.1, it.points[1]!);
      ctx.stroke();
    } else if (it.kind === 'rect') {
      ctx.strokeRect(it.x, it.y, it.w, it.h);
    } else if (it.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        it.x + it.w / 2,
        it.y + it.h / 2,
        Math.abs(it.w / 2),
        Math.abs(it.h / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (it.kind === 'note') {
      ctx.fillStyle = '#fff4b3';
      ctx.fillRect(it.x, it.y, 220, 160);
      ctx.strokeStyle = '#e3c300';
      ctx.lineWidth = 1;
      ctx.strokeRect(it.x, it.y, 220, 160);
      ctx.fillStyle = '#242424';
      ctx.font = '22px Segoe UI, sans-serif';
      wrap(ctx, it.text, it.x + 12, it.y + 34, 196, 28);
    } else if (it.kind === 'text') {
      ctx.font = '32px Segoe UI, sans-serif';
      ctx.fillText(it.text, it.x, it.y);
    }
  }
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  line: number,
) {
  let row = '';
  let yy = y;
  for (const word of text.split(/\s+/)) {
    const next = row ? `${row} ${word}` : word;
    if (ctx.measureText(next).width > width && row) {
      ctx.fillText(row, x, yy);
      row = word;
      yy += line;
    } else row = next;
  }
  if (row) ctx.fillText(row, x, yy);
}

export function Whiteboard({ convId }: { convId: string | undefined }) {
  const s = useStyles();
  const canvas = useRef<HTMLCanvasElement>(null);
  const version = useWhiteboard((st) => st.version);
  const [tool, setTool] = useState<WhiteboardTool>('pen');
  const [color, setColor] = useState(COLORS[0]!);
  const drag = useRef<{ extend?: (x: number, y: number) => void; x: number; y: number } | null>(
    null,
  );
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [typing, setTyping] = useState<{ kind: 'text' | 'note'; x: number; y: number } | null>(
    null,
  );
  const [text, setText] = useState('');

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    renderBoard(ctx, whiteboardItems());
    if (ghost) {
      ctx.strokeStyle = color;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(ghost.x, ghost.y, ghost.w, ghost.h);
      ctx.setLineDash([]);
    }
  }, [version, ghost, color]);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * BOARD_W),
      y: Math.round(((e.clientY - r.top) / r.height) * BOARD_H),
    };
  };

  const tools: Array<[WhiteboardTool, string, React.ReactElement]> = [
    ['pen', strings.inCall.pen, <Edit20Regular key="p" />],
    ['rect', strings.inCall.rect, <RectangleLandscape20Regular key="r" />],
    ['ellipse', strings.inCall.ellipse, <Circle20Regular key="e" />],
    ['text', strings.inCall.text, <TextT20Regular key="t" />],
    ['note', strings.inCall.note, <Note20Regular key="n" />],
  ];

  const exportPng = async () => {
    if (!convId || !canvas.current) return;
    const blob = await new Promise<Blob | null>((r) => canvas.current!.toBlob(r, 'image/png'));
    if (!blob) return;
    await core.invoke('files.share', {
      convId,
      name: `Whiteboard ${new Date().toLocaleString().replace(/[/:]/g, '-')}.png`,
      mime: 'image/png',
      data: new Uint8Array(await blob.arrayBuffer()),
    });
  };

  return (
    <div className={s.root} data-testid="whiteboard">
      <div className={s.bar}>
        <Toolbar size="small" aria-label={strings.inCall.whiteboard}>
          {tools.map(([id, label, icon]) => (
            <Tooltip key={id} content={label} relationship="label">
              <ToolbarButton
                aria-label={label}
                aria-pressed={tool === id}
                appearance={tool === id ? 'primary' : 'subtle'}
                icon={icon}
                onClick={() => setTool(id)}
                data-testid={`wb-${id}`}
              />
            </Tooltip>
          ))}
          <ToolbarDivider />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              className={mergeClasses(s.swatch, color === c && s.chosen)}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <ToolbarDivider />
          <Tooltip content={strings.inCall.clear} relationship="label">
            <ToolbarButton
              aria-label={strings.inCall.clear}
              icon={<Delete20Regular />}
              onClick={clearWhiteboard}
            />
          </Tooltip>
          {convId && (
            <Tooltip content={strings.inCall.exportPng} relationship="label">
              <ToolbarButton
                aria-label={strings.inCall.exportPng}
                icon={<ImageArrowForward20Regular />}
                onClick={() => void exportPng()}
                data-testid="wb-export"
              />
            </Tooltip>
          )}
        </Toolbar>
        <span style={{ flex: 1 }} />
        <Button size="small" onClick={() => setWhiteboardOpen(false)} data-testid="wb-close">
          {strings.inCall.closeBoard}
        </Button>
      </div>
      <div className={s.canvasWrap}>
        <canvas
          ref={canvas}
          width={BOARD_W}
          height={BOARD_H}
          className={s.canvas}
          data-testid="wb-canvas"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = point(e);
            if (tool === 'pen') {
              drag.current = { extend: beginStroke(color, p.x, p.y), ...p };
            } else if (tool === 'text' || tool === 'note') {
              setText('');
              setTyping({ kind: tool, ...p });
            } else {
              drag.current = { ...p };
            }
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const p = point(e);
            if (d.extend) d.extend(p.x, p.y);
            else
              setGhost({
                x: Math.min(d.x, p.x),
                y: Math.min(d.y, p.y),
                w: Math.abs(p.x - d.x),
                h: Math.abs(p.y - d.y),
              });
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            setGhost(null);
            if (!d || d.extend) return;
            const p = point(e);
            const box = {
              x: Math.min(d.x, p.x),
              y: Math.min(d.y, p.y),
              w: Math.abs(p.x - d.x),
              h: Math.abs(p.y - d.y),
            };
            if (box.w > 3 || box.h > 3) {
              addShape({ kind: tool === 'ellipse' ? 'ellipse' : 'rect', color, text: '', ...box });
            }
          }}
        />
      </div>
      {typing && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setTyping(null)}>
          <DialogSurface>
            <DialogBody>
              <DialogContent>
                <Input
                  autoFocus
                  value={text}
                  maxLength={500}
                  placeholder={strings.inCall.textPrompt}
                  onChange={(_e, d) => setText(d.value)}
                  data-testid="wb-text-input"
                  style={{ width: '100%' }}
                />
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setTyping(null)}>{strings.me.cancel}</Button>
                <Button
                  appearance="primary"
                  disabled={!text.trim()}
                  data-testid="wb-text-add"
                  onClick={() => {
                    addShape({
                      kind: typing.kind,
                      color,
                      x: typing.x,
                      y: typing.y,
                      w: 0,
                      h: 0,
                      text: text.trim(),
                    });
                    setTyping(null);
                  }}
                >
                  {strings.groups.add}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
