// Test-only, loaded with `node --import`: runs a script against a real Sabia
// origin without the network. Requests to `from` go to the local server at
// `to`; every request is logged under the URL the script asked for, and any
// other origin fails the way an unreachable host does.
import { appendFileSync } from "node:fs";

const { from, to, log } = JSON.parse(process.env.SABIA_TEST_FETCH_ROUTE);
const fetchLocally = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  appendFileSync(log, `${init.method ?? "GET"} ${url.href}\n`);
  if (url.origin !== from) throw new TypeError("fetch failed");
  return fetchLocally(new URL(`${url.pathname}${url.search}`, to), init);
};
