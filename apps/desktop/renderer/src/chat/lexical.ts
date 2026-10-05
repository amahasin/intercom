import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from 'lexical';
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
