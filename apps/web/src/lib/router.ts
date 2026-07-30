import { useCallback, useEffect, useState } from 'react';
import { encodePageName, normalizePageName } from '@spark/core';

/**
 * Routing, in about forty lines.
 *
 * Spark has three destinations, so a router library would be more machinery
 * than the problem needs. Real URLs (rather than hashes) mean pages can be
 * bookmarked and linked to.
 */

export type Route = { kind: 'page'; page: string } | { kind: 'home' };

export function parseRoute(pathname: string): Route {
  // Tasks used to have a route of its own. It is a virtual *page* now, so the
  // old URL redirects rather than breaking anyone's bookmark.
  if (pathname === '/tasks') return { kind: 'page', page: 'Tasks' };

  if (pathname.startsWith('/p/')) {
    const page = decodePath(pathname.slice(3));
    return page ? { kind: 'page', page } : { kind: 'home' };
  }
  return { kind: 'home' };
}

export function routeToPath(route: Route): string {
  return route.kind === 'page' ? `/p/${encodePageName(route.page)}` : '/';
}

export function useRoute(): [Route, (route: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  // Normalise legacy or shorthand URLs to the canonical one, without adding a
  // history entry — pressing Back should leave the app, not bounce.
  //
  // Read from `location` rather than from `route`, and re-derive the route from
  // it. This effect runs once, and by the time it does the workbench has
  // already pointed the URL at whatever it opened; comparing against the route
  // captured on the first render would helpfully undo that.
  useEffect(() => {
    const current = window.location.pathname;
    const canonical = routeToPath(parseRoute(current));
    if (canonical !== current) {
      window.history.replaceState(null, '', canonical);
    }
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route, replace = false) => {
    const path = routeToPath(next);
    if (path !== window.location.pathname) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}

function decodePath(raw: string): string {
  const decoded = raw
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
  return normalizePageName(decoded);
}
