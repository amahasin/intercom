/**
 * Back and forward through the places the user has been (a rail and the chat open in it),
 * like the arrows beside the search box. History is kept for this session only.
 */
import { create } from 'zustand';
import { selectConversation, useApp, type RailId } from '../state.ts';

interface Place {
  rail: RailId;
  conv: string | undefined;
}

const MAX_PLACES = 100;
const places: Place[] = [];
let index = -1;
let moving = false;

export const useNav = create(() => ({ canBack: false, canForward: false }));

function publish(): void {
  useNav.setState({ canBack: index > 0, canForward: index < places.length - 1 });
}

function here(): Place {
  const s = useApp.getState();
  return { rail: s.rail, conv: s.selectedConv };
}

/** Start following where the user goes. */
export function initNav(): void {
  places.push(here());
  index = 0;
  publish();
  useApp.subscribe((s, prev) => {
    if (moving || (s.rail === prev.rail && s.selectedConv === prev.selectedConv)) return;
    const next = here();
    const cur = places[index];
    if (cur && cur.rail === next.rail && cur.conv === next.conv) return;
    // Going somewhere new drops whatever was ahead.
    places.splice(index + 1);
    places.push(next);
    if (places.length > MAX_PLACES) places.shift();
    index = places.length - 1;
    publish();
  });
}

async function go(step: -1 | 1): Promise<void> {
  const to = index + step;
  const place = places[to];
  if (!place) return;
  index = to;
  moving = true;
  try {
    if (place.conv) await selectConversation(place.conv);
    else useApp.setState({ selectedConv: undefined });
    // Opening a chat may switch rails: the place being returned to has the last word.
    useApp.setState({ rail: place.rail });
  } finally {
    moving = false;
    publish();
  }
}

export const goBack = () => go(-1);
export const goForward = () => go(1);
