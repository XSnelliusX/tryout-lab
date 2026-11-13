// Authenticated access to the local API. Token handling: launch URL query -> sessionStorage -> URL cleaned.
import { toast } from "/glass.js";
import { store } from "/store.js";

const TOKEN_KEY = "meeting-assistant-token";

function readToken() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  let stored = "";
  try {
    if (fromUrl) sessionStorage.setItem(TOKEN_KEY, fromUrl);
    stored = sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (_) { /* storage blocked: fall back to the URL token for this page load */ }
  if (location.search) history.replaceState(null, "", location.pathname);
  return fromUrl || stored;
}
const token = readToken();

export function getToken() { return token; }

/** GET when body is undefined, otherwise POST JSON. Resolves parsed JSON; rejects with Error(server message). */
export async function api(path, body) {
  const options = { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try { response = await fetch(path, options); }
  catch (_) { throw new Error("Cannot reach the local Meeting Assistant server."); }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`Request failed (HTTP ${response.status})`); }
  if (!response.ok) throw new Error((data && data.error) || `Request failed (HTTP ${response.status})`);
  return data;
}

let chain = Promise.resolve();

/**
 * POST (or GET) through api(), one at a time. On failure: error toast (unless quiet) and resolves false.
 * On success: success(result), then store.refresh(), resolves true.
 */
export function action(path, body, { success, quiet } = {}) {
  const run = async () => {
    store.setBusy(+1);
    try {
      let result;
      try { result = await api(path, body); }
      catch (error) {
        if (!quiet) toast(error.message, { kind: "error" });
        return false;
      }
      try { success?.(result); } catch (error) { console.error(error); }
      await store.refresh();
      return true;
    } finally { store.setBusy(-1); }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
