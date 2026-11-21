/**
 * API deprecation registry (issue #985).
 *
 * Single source of truth for the observable sunset signal described in
 * docs/DEPRECATION_POLICY.md. Deprecated routes emit `Deprecation`, `Sunset`
 * and `Link` response headers, and the full registry is published at
 * `GET /indexer/deprecations` so external consumers can poll it.
 *
 * Entries are added only when a real deprecation starts. The list is
 * deliberately empty today: no route is deprecated as of this change, and
 * inventing a fake sunset date on a live route would be worse than shipping
 * the mechanism unused.
 *
 * Keep this module dependency-free and pure so it is trivially unit-testable.
 */

export interface ApiDeprecation {
  /** Express path template exactly as written in api.ts, e.g. '/circles/:address/activity'. */
  route: string;
  method: 'GET';
  /** ISO date the deprecation was announced. */
  since: string;
  /** ISO date the route/field stops being supported. */
  sunset: string;
  /** Optional replacement route or field. */
  replacement?: string;
  /** Optional human-readable migration note. */
  note?: string;
}

export const CHANGELOG_URL =
  'https://github.com/CIRCLEUP-AJO/CIRCLEUP/blob/main/CHANGELOG.md';

export const API_DEPRECATIONS: readonly ApiDeprecation[] = [];

/** Build the response headers for a deprecated route. */
export function deprecationHeaders(d: ApiDeprecation): Record<string, string> {
  const links = [`<${CHANGELOG_URL}>; rel="deprecation"`];
  if (d.replacement) {
    links.push(`<${d.replacement}>; rel="successor-version"`);
  }
  return {
    Deprecation: 'true',
    Sunset: d.sunset,
    Link: links.join(', '),
  };
}

/** Look up an active deprecation by HTTP method and Express path template. */
export function findDeprecation(
  method: string,
  routePath: string,
): ApiDeprecation | undefined {
  return API_DEPRECATIONS.find(
    (d) => d.method === method.toUpperCase() && d.route === routePath,
  );
}

/** True when `value` is a parseable ISO-8601 date string. */
export function isIsoDate(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(value.slice(0, 10));
}
