import { makeStyles } from '@fluentui/react-components';

/** The widest a conversation's messages and composer grow, however wide the window is. */
export const CHAT_MAX_WIDTH = '910px';
/** Room each side of a chat's 910 px for the senders' pictures (they hang outside the bubbles). */
const PICTURE_ROOM = 48;
/** The call window's side panel is narrow: the pictures hang in 44 px, the right side keeps 12. */
const CALL_PICTURE_ROOM = 44;

export const useColumn = makeStyles({
  /** Centred, at most 910 px wide (the scroll bar and the header still span the window). */
  column: {
    width: '100%',
    maxWidth: CHAT_MAX_WIDTH,
    marginLeft: 'auto',
    marginRight: 'auto',
    boxSizing: 'border-box',
  },
  /**
   * A chat's column as Teams draws it: the bubbles and the composer share the same 910 px
   * (centred), and the pictures hang in the free space to their left.
   */
  chat: {
    width: '100%',
    maxWidth: `calc(${CHAT_MAX_WIDTH} + ${PICTURE_ROOM * 2}px)`,
    marginLeft: 'auto',
    marginRight: 'auto',
    boxSizing: 'border-box',
    paddingLeft: `${PICTURE_ROOM}px`,
    paddingRight: `${PICTURE_ROOM}px`,
  },
  /** The same column, narrow, for the chat in the call window. */
  callChat: {
    width: '100%',
    boxSizing: 'border-box',
    paddingLeft: `${CALL_PICTURE_ROOM}px`,
    paddingRight: '12px',
  },
});
