import { Fragment, type ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { displayName, useApp } from '../state.ts';

/**
 * Renders the restricted Markdown used on the wire into React elements. It never uses
 * innerHTML: text from peers can only ever become text, and only http, https and mailto
 * links are made clickable (they open in the default browser).
 */

const useStyles = makeStyles({
  p: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  pre: {
    margin: `${tokens.spacingVerticalXS} 0`,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground4,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: '0.92em',
    padding: '0 3px',
    borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground4,
  },
  quote: {
    margin: `${tokens.spacingVerticalXS} 0`,
    paddingLeft: tokens.spacingHorizontalS,
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground2,
  },
  list: { margin: `${tokens.spacingVerticalXXS} 0`, paddingLeft: '22px' },
  mention: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  mentionMe: {
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    background: tokens.colorBrandBackground2,
    borderRadius: tokens.borderRadiusSmall,
    padding: '0 2px',
  },
  link: { color: tokens.colorBrandForegroundLink },
});

type Styles = ReturnType<typeof useStyles>;

const INLINE =
  /(`[^`\n]+`)|@\[([^\]\n]{1,64})\]\(([a-z2-7]{32})\)|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)|(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\6|~~(?=\S)([\s\S]+?)(?<=\S)~~|(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:'
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function inline(text: string, s: Styles, selfId: string | undefined, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${key}-${n++}`;
    if (m[1])
      out.push(
        <code key={k} className={s.code}>
          {m[1].slice(1, -1)}
        </code>,
      );
    else if (m[3]) {
      const me = m[3] === selfId;
      out.push(
        <span key={k} className={me ? s.mentionMe : s.mention} data-mention={m[3]}>
          @{displayName(m[3]) || m[2]}
        </span>,
      );
    } else if (m[5]) {
      const href = safeHref(m[5]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer" className={s.link}>
            {inline(m[4]!, s, selfId, k)}
          </a>
        ) : (
          m[4]
        ),
      );
    } else if (m[7]) out.push(<strong key={k}>{inline(m[7], s, selfId, k)}</strong>);
    else if (m[8]) out.push(<del key={k}>{inline(m[8], s, selfId, k)}</del>);
    else if (m[9] ?? m[10]) out.push(<em key={k}>{inline((m[9] ?? m[10])!, s, selfId, k)}</em>);
    else if (m[11]) {
      const href = safeHref(m[11]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer" className={s.link}>
            {m[11]}
          </a>
        ) : (
          m[11]
        ),
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  const s = useStyles();
  const selfId = useApp((st) => st.identity?.userId);
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    const body = para.join('\n');
    blocks.push(
      <p key={`p${blocks.length}`} className={s.p}>
        {inline(body, s, selfId, `p${blocks.length}`)}
      </p>,
    );
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i]!);
      blocks.push(
        <pre key={`c${blocks.length}`} className={s.pre}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        items.push(m[2]!);
        i++;
      }
      i--;
      const children = items.map((it, j) => (
        <li key={j}>{inline(it, s, selfId, `l${blocks.length}-${j}`)}</li>
      ));
      blocks.push(
        ordered ? (
          <ol key={`o${blocks.length}`} className={s.list}>
            {children}
          </ol>
        ) : (
          <ul key={`u${blocks.length}`} className={s.list}>
            {children}
          </ul>
        ),
      );
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i]!))
        quoted.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      i--;
      blocks.push(
        <blockquote key={`q${blocks.length}`} className={s.quote}>
          {inline(quoted.join('\n'), s, selfId, `q${blocks.length}`)}
        </blockquote>,
      );
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
  }
  flush();
  return <Fragment>{blocks}</Fragment>;
}
