/**
 * Host half of `dsh-i-hao-hai-pa`.
 *
 * The whole behaviour lives in the browser module (`client.js`): it watches the
 * user's own turns, decides whether the message is aimed at DSH, and plays the
 * collapse animation on the shell. The Host needs no services, so this stays a
 * no-op that still gives the bundle a loadable entry.
 */
export function apply() {}
