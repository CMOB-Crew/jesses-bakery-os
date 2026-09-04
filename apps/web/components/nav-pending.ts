"use client";

// A one-value store for "a navigation is in flight, and here is where to".
//
// WHY THIS EXISTS AT ALL, because the obvious answer is loading.tsx and that
// answer is banned here. Commit 8c8e748 removed all 22 loading.tsx files after
// measuring, on the live site, that every page carrying one shipped a React
// POSTPONED boundary that Netlify's runtime never resumed -- so the page
// rendered perfectly and ignored every tap. Nothing inside it was interactive
// until you navigated to it from somewhere else. A driver opening a bookmark
// got a screen that looked right and did nothing.
//
// That fix cost the skeletons. Netlify's own docs then closed the door on the
// plan to get them back: they say not to pin @netlify/plugin-nextjs because
// they auto-update it on every build, so the app is already on the newest
// adapter and pinning would change nothing.
//
// This is the way back that does not touch a Suspense boundary. useLinkStatus
// is a client hook -- it reports that THIS link's navigation is in flight, from
// inside an already-hydrated component. No boundary, no postponed shell, no
// server render involved. It cannot bring the dead-page bug back because it is
// not the mechanism that caused it.
//
// What it does NOT cover: a cold load or a hard refresh. There is no client
// running yet, so nothing can draw anything until the server responds. Only
// streaming could cover that case, and streaming is what is broken. This
// covers every click made inside the app, which is where the whole team spends
// its day.
//
// MEASURED IN A REAL BROWSER, not reasoned about. Production build, Chromium,
// with the target route's request artificially stalled to stand in for a
// Netlify cold render:
//
//   slow navigation (2.5s)      skeleton appears, sidebar stays live,
//                               page arrives, skeleton gone
//   fast navigation             0 skeleton frames seen at 25ms polling --
//                               the 180ms threshold does its job
//   second click mid-navigation ends on the second page, no skeleton left
//   request that NEVER answers  skeleton clears itself at the 20s backstop
//                               and the page is usable again
//   hard refresh on /stores     0 postponed markers, filter chips respond --
//                               the 8c8e748 bug stays fixed
//
// Two of those runs were thrown away before they counted. The first pointed at
// a stale `next start` still serving chunk names the rebuild had replaced, so
// every client chunk 404'd and none of this code was running at all; the second
// navigated between two routes returning 500 against the test database, so it
// was measuring an error page. Both looked like real results.
//
// THE TIMING LIVES HERE, NOT IN THE COMPONENT. The first version kept `visible`
// in React state and flipped it from an effect, which the lint rules rejected
// as cascading renders -- correctly. Holding both the target and whether it is
// old enough to show in the store means the component derives everything from
// one subscription and owns no state at all.

type Nav = { href: string; visible: boolean } | null;

let current: Nav = null;
const subscribers = new Set<() => void>();

let showTimer: ReturnType<typeof setTimeout> | null = null;
let giveUpTimer: ReturnType<typeof setTimeout> | null = null;

// Below this, a navigation is quick enough that a skeleton is a flash of noise
// rather than feedback. Above it, the user is waiting and needs to see that
// their click landed.
const SHOW_AFTER_MS = 180;

// A skeleton that never goes away is worse than no skeleton -- that is the same
// failure the loading.tsx removal was fixing, wearing different clothes. This is
// the hard stop: whatever the router does, the page comes back.
const GIVE_UP_MS = 20000;

function emit() {
  for (const fn of subscribers) fn();
}

function stopTimers() {
  if (showTimer) clearTimeout(showTimer);
  if (giveUpTimer) clearTimeout(giveUpTimer);
  showTimer = null;
  giveUpTimer = null;
}

export function subscribeNav(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getNav(): Nav {
  return current;
}

// useSyncExternalStore demands a server snapshot, and during SSR there is never
// a navigation in flight by definition. A stable null, not a fresh object --
// returning a new object each call is an infinite render loop.
export function getNavServer(): Nav {
  return null;
}

// Set when a link goes pending, cleared when it settles. Scoped by href so two
// links reporting in either order cannot leave the store stuck on a navigation
// that already finished: only the link that set it may clear it.
export function setNavPending(href: string, pending: boolean) {
  if (pending) {
    if (current?.href === href) return;
    stopTimers();
    current = { href, visible: false };
    emit();
    showTimer = setTimeout(() => {
      if (current?.href !== href) return;
      current = { href, visible: true };
      emit();
    }, SHOW_AFTER_MS);
    giveUpTimer = setTimeout(clearNav, GIVE_UP_MS);
    return;
  }
  if (current?.href === href) clearNav();
}

export function clearNav() {
  stopTimers();
  if (current === null) return;
  current = null;
  emit();
}
