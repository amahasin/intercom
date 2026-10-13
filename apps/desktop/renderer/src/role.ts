/**
 * Which window this page is: the main window, the window of one call, or the small window
 * that rings for an incoming call. Main picks it with the page's address (see main/windows.ts).
 */
const params = new URLSearchParams(window.location.search);

export type WindowRole = 'main' | 'call' | 'incoming';
const asked = params.get('role');
export const ROLE: WindowRole = asked === 'call' || asked === 'incoming' ? asked : 'main';
/** The call a call window or a ringing window is for. */
export const BOUND_CALL: string | undefined = params.get('call') ?? undefined;
