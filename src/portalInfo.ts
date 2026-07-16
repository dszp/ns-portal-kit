/**
 * What a portal-mode Worker says at `/`.
 *
 * Portal mode is the backend half of an injected add-on, so it has no UI and the internal SPA is
 * deliberately withheld (a tooling surface shouldn't exist on a user-facing endpoint, and its fetches
 * carry no ns_t anyway). It still answers 404 — but a bare 404 is a dead end for whoever just deployed
 * this and opened the URL to see if it worked. So: 404 with an explanation.
 *
 * Discloses nothing — no config, no hostnames, no data. It's the same page for every deployment.
 */
import { page } from './pageShell.js';

export function portalModeHtml(productName = 'NS Portal Kit'): string {
  return page({
    title: `${productName} — portal mode`,
    heading: 'This is working. It just has no page.',
    intro:
      'This Worker is running in portal mode, which is the BACKEND half of a Manager Portal add-on. It ' +
      'has no interface of its own by design — it answers API calls from JavaScript running inside your ' +
      'Manager Portal, and serves nothing to a browser that visits it directly.',
    items: [
      {
        level: 'step',
        title: 'It only answers calls that carry a user\'s login token',
        body: [
          'Every request must send Authorization: Bearer <ns_t> — the token your Manager Portal already ' +
            'issued to the logged-in user. No token, no answer: there is no stored credential here to fall back on.',
          'Reads run as that user, and NetSapiens enforces what they may see.',
        ],
      },
      {
        level: 'step',
        title: 'You need injected JavaScript to call it',
        body: [
          'Something inside your Manager Portal has to read the ns_t, call this Worker, and put the result ' +
            'on the page. A reference script is planned but not published yet, so today that part is yours to write.',
        ],
      },
      {
        level: 'step',
        title: 'Wanted the viewer instead?',
        body: [
          'The domain-browser UI is service mode: clear PORTAL_MODE, set an NS_API_TOKEN, and put Cloudflare ' +
            'Access in front of it. That is the one to start with.',
        ],
      },
    ],
    footer: 'Health check: <code>/health</code>. Setup and the full request flow are in SETUP.md.',
  });
}
