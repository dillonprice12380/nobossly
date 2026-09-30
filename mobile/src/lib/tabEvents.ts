// Tapping the tab you're already on takes that tab back to its home page, as
// native apps do. The tab bar and the web view live in different components,
// so they talk through this.
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function emitTabReselect(tab: string) {
  listeners.get(tab)?.forEach(l => l());
}

export function onTabReselect(tab: string, l: Listener) {
  if (!listeners.has(tab)) listeners.set(tab, new Set());
  listeners.get(tab)!.add(l);
  return () => { listeners.get(tab)?.delete(l); };
}
