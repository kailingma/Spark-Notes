import { useCallback, useEffect, useState } from 'react';
import { encodePageName, normalizePageName } from '@spark/core';

/**
 * Routing, in about forty lines.
 *
 * Spark has three destinations, so a router library would be more machinery
 * than the problem needs. Real URLs (rather than hashes) mean pages can be
 * bookmarked and linked to.
 */

export type Route =
  | { kind: 'page'; page: string }
  | { kind: 'tasks' }
  | { kind: 'home' };

export const TASKS_ROUTE = '/tasks';

export function parseRoute(pathname: string): Route {
  if (pathname === TASKS_ROUTE) return { kind: 'tasks' };
  if (pathname.startsWith('/p/')) {
    const page = decodePath(pathname.slice(3));
    return page ? { kind: 'page', page } : { kind: 'home' };
  }
  return { kind: 'home' };
}

export function routeToPath(route: Route): string {
  switch (route.kind) {
    case 'tasks':
      return TASKS_ROUTE;
    case 'page':
      return `/p/${encodePageName(route.page)}`;
    default:
      return '/';
  }
}

export function useRoute(): [Route, (route: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

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
