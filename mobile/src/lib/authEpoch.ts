// Every tab is its own web view, and they share one cookie jar. When someone
// signs in or out in one tab, the others are still showing the old account (or
// the login page). Each tab remembers the epoch it last loaded under and
// reloads its home page when it comes into view under a newer one.
type Listener = (epoch: number) => void;

let epoch = 0;
const listeners = new Set<Listener>();

export const currentAuthEpoch = () => epoch;

export function bumpAuthEpoch() {
  epoch += 1;
  listeners.forEach(l => l(epoch));
}

export function onAuthEpoch(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
