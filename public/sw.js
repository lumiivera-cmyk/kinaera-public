/**
 * Kinaera's service worker.
 *
 * A service worker is a small script the browser runs in the background for
 * a website. Along with manifest.webmanifest, it's what lets the browser
 * install the site as an app on your home screen.
 *
 * It's deliberately minimal: it caches nothing, and has no fetch handler, so
 * every request goes straight to the server as if there were no worker
 * (current browsers no longer need one to offer installing). The server runs
 * on the same phone, so there's no slow network to hide, and caching would
 * only risk showing you an out-of-date app or chat. If the server isn't
 * running, the browser shows its normal "can't connect" page, which is the
 * honest answer: start the server in Termux.
 */

// Take over as soon as a new version is installed, instead of waiting for
// every open Kinaera tab to close. That way updates apply on the next reload.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
