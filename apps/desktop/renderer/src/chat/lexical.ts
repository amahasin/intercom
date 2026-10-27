import {
  $applyNodeReplacement,
  $createParagraphNode,
  $isLineBreakNode,
  $isParagraphNode,
  TextNode,
  type EditorConfig,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type SerializedTextNode,
  type Spread,
} from 'lexical';
import { $setBlocksType } from '@lexical/selection';
import {
  HEADING,
  TRANSFORMERS,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown';

type SerializedMentionNode = Spread<{ userId: string }, SerializedTextNode>;

/** An @mention in the editor; exported to the wire as `@[Name](userId)`. */
export class MentionNode extends TextNode {
  __userId: string;

  static override getType(): string {
    return 'mention';
  }

  static override clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__userId, node.__text, node.__key);
  }

  constructor(userId: string, text: string, key?: NodeKey) {
    super(text, key);
    this.__userId = userId;
  }

  getUserId(): string {
    return this.getLatest().__userId;
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = 'om-mention';
    dom.spellcheck = false;
    return dom;
  }

  static override importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode(json.userId, json.text);
  }

  override exportJSON(): SerializedMentionNode {
    return { ...super.exportJSON(), userId: this.__userId, type: 'mention', version: 1 };
  }

  override isTextEntity(): true {
    return true;
  }

  override canInsertTextBefore(): boolean {
    return false;
  }

  override canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createMentionNode(userId: string, text: string): MentionNode {
  return $applyNodeReplacement(
    new MentionNode(userId, text).setMode('segmented').toggleDirectionless(),
  );
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

const MENTION: TextMatchTransformer = {
  dependencies: [MentionNode],
  export: (node) =>
    $isMentionNode(node)
      ? `@[${node.getTextContent().replace(/^@/, '')}](${node.getUserId()})`
      : null,
  importRegExp: /@\[([^\]\n]{1,64})\]\(([a-z2-7]{32})\)/,
  regExp: /@\[([^\]\n]{1,64})\]\(([a-z2-7]{32})\)$/,
  replace: (textNode, match) => {
    textNode.replace($createMentionNode(match[2]!, `@${match[1]!}`));
  },
  trigger: ')',
  type: 'text-match',
};

/** The Markdown subset on the wire: everything Lexical offers except headings, plus mentions. */
export const OM_TRANSFORMERS: Transformer[] = [
  MENTION,
  ...TRANSFORMERS.filter((t) => t !== HEADING),
];

export const EDITOR_THEME = {
  paragraph: 'om-p',
  quote: 'om-quote',
  code: 'om-codeblock',
  link: 'om-link',
  list: { ul: 'om-ul', ol: 'om-ol', listitem: 'om-li' },
  text: { bold: 'om-b', italic: 'om-i', strikethrough: 'om-s', code: 'om-code' },
};

/**
 * Turn the selected part of a message into a block (a quote or a code block), and leave the text
 * before and after it as it was, in paragraphs of their own. With nothing selected it is the line
 * the cursor is on (a message written with Shift+Enter is one paragraph of several lines).
 * Anything else (the selection reaches into several blocks, or the block is a list, a quote, a
 * code block already) is converted whole, as `$setBlocksType` does.
 */
export function $makeBlock(sel: RangeSelection, create: () => ElementNode): void {
  const para = sel.anchor.getNode().getTopLevelElement();
  if (!para || !$isParagraphNode(para) || !para.is(sel.focus.getNode().getTopLevelElement())) {
    $setBlocksType(sel, create);
    return;
  }
  const lineBreakAt = (i: number) => $isLineBreakNode(para.getChildAtIndex(i));
  const size = para.getChildrenSize();
  // The children of the paragraph that are to become the block: from `from` to `to`, inclusive.
  let from: number;
  let to: number;
  if (sel.isCollapsed()) {
    const at = sel.anchor.getNode();
    // The cursor is in a child (text), or between two children (on an empty line, or at an edge).
    const index = at.is(para) ? -1 : at.getIndexWithinParent();
    from = index >= 0 ? index : sel.anchor.offset;
    to = index >= 0 ? index : sel.anchor.offset - 1;
    while (from > 0 && !lineBreakAt(from - 1)) from--;
    while (to < size - 1 && !lineBreakAt(to + 1)) to++;
  } else {
    // Splits the text at both ends of the selection, so only what is selected is taken.
    const nodes = sel.extract();
    if (nodes.length === 0 || nodes.some((n) => !n.getParent()?.is(para))) {
      $setBlocksType(sel, create);
      return;
    }
    from = nodes[0]!.getIndexWithinParent();
    to = nodes[nodes.length - 1]!.getIndexWithinParent();
  }
  const children = para.getChildren();
  const picked = children.slice(from, to + 1);
  const before = children.slice(0, from);
  const after = children.slice(to + 1);
  // A line break that ends the part before, starts the part after, or edges the selection: the
  // blocks are now the break between them.
  while ($isLineBreakNode(picked[0])) picked.shift()!.remove();
  while ($isLineBreakNode(picked[picked.length - 1])) picked.pop()!.remove();
  if ($isLineBreakNode(before[before.length - 1])) before.pop()!.remove();
  if ($isLineBreakNode(after[0])) after.shift()!.remove();

  const block = create();
  block.append(...picked);
  para.insertAfter(block);
  if (after.length > 0) {
    const rest = $createParagraphNode();
    rest.append(...after);
    block.insertAfter(rest);
  }
  if (before.length === 0) para.remove();
  block.selectEnd();
}
