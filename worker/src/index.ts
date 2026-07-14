/**
 * Kindle Todo — Cloudflare Worker.
 *
 * Serves the todo page, a JSON API, and a full-screen /todo.png render, backed
 * by a pluggable TodoProvider (currently Microsoft To Do). Access is gated by a
 * secret token in the URL (?t=...).
 *
 * Which list is served to the Kindle is selectable from the web page: the
 * config default (MS_DEFAULT_LIST_ID) is preselected, and the chosen list id is
 * persisted in KV (LIST_STORE) so the Kindle's independent polling picks it up.
 *
 * Routes (all except GET / require a valid ?t=<TODO_TOKEN>):
 *   GET  /                -> HTML page (public shell; prompts for the token and
 *                            remembers it in localStorage)
 *   GET  /api/lists       -> { lists: [{ id, name }], selected }
 *   POST /api/selection   -> set the served list (?list=<id>); { selected }
 *   GET  /api/todos       -> { title, todos }
 *   GET  /todo.png        -> full-screen 1072x1448 PNG (Kindle image mode)
 *   GET  /error/<kind>.png-> a rendered error screen (for the device to pre-cache)
 *
 * The served list is cached briefly (LIST_CACHE_TTL) so the Kindle's ~15s
 * polling doesn't hammer the backend API; changing the selection invalidates
 * the cache so the switch shows on the next poll. Completing a task is done in
 * the upstream To Do app, not here.
 *
 * When the backend fails, /todo.png keeps serving the last-known-good list for a
 * short grace period (rides out blips), then falls back to a rendered error
 * screen. Failures the Worker can't even answer (no Wi-Fi, wrong URL) are drawn
 * on-device from pre-downloaded PNGs — see src/errors.ts.
 */
import { renderTodoPng, renderErrorPng } from "./og";
import type { Todo } from "./providers/types";
import { createProvider, type ProviderEnv } from "./providers/factory";
import { ERROR_SCREENS, classifyProviderError, type ErrorKind } from "./errors";

interface Env extends ProviderEnv {
  TODO_TOKEN: string;
  /** KV persisting which list is served to the Kindle. Falls back to default. */
  LIST_STORE?: KVNamespace;
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Seconds to cache the provider's task list (bounds backend API calls). */
const LIST_CACHE_TTL = 30;
/** KV key holding the selected list id. */
const SELECTED_LIST_KEY = "selected_list_id";
// Last-known-good list lives in the edge Cache API (no KV write limits); its TTL
// *is* the grace window — once it expires, /todo.png shows an error instead.
const LAST_GOOD_KEY = "https://todo.internal/last-good";
const LAST_GOOD_GRACE_TTL = 300; // seconds to keep serving the last good list

// Reuse the provider across requests in the same isolate so its in-memory
// access-token cache (and KV-backed refresh token) is shared.
let providerSingleton: ReturnType<typeof createProvider> | undefined;
function getProvider(env: Env) {
  return (providerSingleton ??= createProvider(env));
}

/** The header title plus the tasks to show. */
interface TodoData {
  title: string;
  todos: Todo[];
}

/** Per-list edge cache key for the rendered task list. */
function listCacheKey(listId: string): Request {
  return new Request(`https://todo.internal/list/${encodeURIComponent(listId)}`);
}

/** The list id currently served to the Kindle (KV-backed, default fallback). */
async function getSelectedListId(env: Env): Promise<string> {
  const stored = await env.LIST_STORE?.get(SELECTED_LIST_KEY);
  return stored ?? getProvider(env).defaultListId;
}

/** Provider data for a list, served from the edge cache when fresh. */
async function getData(env: Env, ctx: ExecutionContext, listId: string): Promise<TodoData> {
  const cache = caches.default;
  const key = listCacheKey(listId);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as TodoData;

  const provider = getProvider(env);
  const [title, todos] = await Promise.all([provider.title(listId), provider.list(listId)]);
  const data: TodoData = { title, todos };
  ctx.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LIST_CACHE_TTL}` },
      }),
    ),
  );
  // Remember the last successful fetch so /todo.png can ride out backend blips.
  rememberLastGood(ctx, data);
  return data;
}

function invalidateTodos(ctx: ExecutionContext, listId: string): void {
  ctx.waitUntil(caches.default.delete(listCacheKey(listId)));
}

/** Cache the last successful list; the entry's TTL is the grace window. */
function rememberLastGood(ctx: ExecutionContext, data: TodoData): void {
  ctx.waitUntil(
    caches.default.put(
      new Request(LAST_GOOD_KEY),
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LAST_GOOD_GRACE_TTL}` },
      }),
    ),
  );
}

/** The last good list, or null once its grace TTL has lapsed. */
async function getLastGood(): Promise<TodoData | null> {
  const hit = await caches.default.match(new Request(LAST_GOOD_KEY));
  return hit ? ((await hit.json()) as TodoData) : null;
}

// ETag = strong hash of the exact state that determines the rendered image
// (title + tasks), so a list rename, list switch, or task change flips it.
async function etagFor(data: TodoData): Promise<string> {
  return etagForString(JSON.stringify(data));
}

async function etagForString(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

/**
 * Shared PNG delivery: honor If-None-Match (304 → no redraw on the Kindle),
 * cache the rendered bytes by ETag so a given state is rasterized at most once,
 * and return the image with a no-cache ETag for conditional polling.
 */
async function servePng(
  request: Request,
  url: URL,
  ctx: ExecutionContext,
  etag: string,
  render: () => Promise<Response>,
): Promise<Response> {
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
  }
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/__png/${etag.slice(1, -1)}`, url.origin).toString());
  let body: ArrayBuffer;
  const hit = await cache.match(cacheKey);
  if (hit) {
    body = await hit.arrayBuffer();
  } else {
    const rendered = await render();
    body = await rendered.arrayBuffer();
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(body, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
        }),
      ),
    );
  }
  return new Response(body, {
    headers: { "Content-Type": "image/png", ETag: etag, "Cache-Control": "no-cache" },
  });
}

function authorized(url: URL, env: Env): boolean {
  const t = url.searchParams.get("t");
  return !!env.TODO_TOKEN && t === env.TODO_TOKEN;
}

// ES5 + XMLHttpRequest page for the ancient Kindle Voyage/PW4 WebKit browser.
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Todo</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000;
    font-family: Helvetica, Arial, sans-serif; -webkit-text-size-adjust: 100%; }
  h1 { font-size: 28px; margin: 0; padding: 16px 20px; border-bottom: 3px solid #000; }
  #picker { padding: 14px 20px; border-bottom: 3px solid #000; }
  #picker label { display: block; font-size: 18px; color: #444; margin: 0 0 8px; }
  select { font-size: 22px; padding: 8px 10px; width: 100%; background: #fff; color: #000;
    border: 3px solid #000; -webkit-appearance: none; border-radius: 0; }
  #list { list-style: none; margin: 0; padding: 0; }
  li { display: block; border-bottom: 2px solid #000; padding: 18px 20px; min-height: 64px; }
  .txt { font-size: 24px; line-height: 32px; }
  li.done .txt { text-decoration: line-through; color: #888; }
  #msg { padding: 16px 20px; font-size: 20px; color: #444; }
</style>
</head>
<body>
  <h1 id="title">Todo</h1>
  <div id="picker">
    <label for="list-select">List served to the Kindle</label>
    <select id="list-select"></select>
  </div>
  <ul id="list"></ul>
  <div id="msg"></div>
<script type="text/javascript">
(function () {
  var titleEl = document.getElementById("title");
  var listEl = document.getElementById("list");
  var msgEl = document.getElementById("msg");
  var selectEl = document.getElementById("list-select");

  // Token: from ?t= in the URL, else localStorage, else prompt the user.
  // Stored in localStorage so return visits don't need it in the URL.
  var TOKEN = "";
  var Q = "";
  function readUrlToken() { var m = location.search.match(/[?&]t=([^&]*)/); return m ? decodeURIComponent(m[1]) : ""; }
  function storedToken() { try { return localStorage.getItem("todo_token") || ""; } catch (e) { return ""; } }
  function setToken(t) {
    TOKEN = t; Q = "?t=" + encodeURIComponent(t);
    try { if (t) { localStorage.setItem("todo_token", t); } } catch (e) {}
  }
  function promptToken(label) {
    var t = window.prompt(label);
    return t ? t.replace(/^\\s+|\\s+$/g, "") : "";
  }
  // Called when the server rejects the token (401): forget it and ask again.
  function reauth() {
    try { localStorage.removeItem("todo_token"); } catch (e) {}
    var t = promptToken("Access token rejected. Enter access token:");
    if (!t) { setMsg("Access token required. Reload to try again."); return false; }
    setToken(t);
    return true;
  }

  function setTitle(t) { titleEl.innerHTML = ""; titleEl.appendChild(document.createTextNode(t || "Todo")); }
  function setMsg(t) { msgEl.innerHTML = ""; msgEl.appendChild(document.createTextNode(t || "")); }
  function xhr(method, url, cb) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    r.onreadystatechange = function () { if (r.readyState === 4) { cb(r.status, r.responseText); } };
    r.send(null);
  }
  function render(todos) {
    listEl.innerHTML = "";
    var visible = 0;
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      if (t.done) { continue; }
      visible++;
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.className = "txt";
      span.appendChild(document.createTextNode(t.text));
      li.appendChild(span); listEl.appendChild(li);
    }
    if (visible === 0) {
      var d = document.createElement("li");
      d.appendChild(document.createTextNode("All done."));
      listEl.appendChild(d);
    }
  }
  function loadLists(next) {
    xhr("GET", "/api/lists" + Q, function (status, body) {
      if (status === 401) { if (reauth()) { loadLists(next); } return; }
      if (status === 200) {
        var data;
        try { data = JSON.parse(body); } catch (e) { data = null; }
        if (data) {
          var lists = data.lists || [];
          selectEl.innerHTML = "";
          for (var i = 0; i < lists.length; i++) {
            var opt = document.createElement("option");
            opt.value = lists[i].id;
            opt.appendChild(document.createTextNode(lists[i].name));
            if (lists[i].id === data.selected) { opt.selected = true; }
            selectEl.appendChild(opt);
          }
        }
      }
      if (next) { next(); }
    });
  }
  function loadTodos() {
    setMsg("Loading...");
    xhr("GET", "/api/todos" + Q, function (status, body) {
      if (status === 401) { if (reauth()) { loadTodos(); } return; }
      if (status !== 200) { setMsg("Could not load todos (status " + status + ")."); return; }
      var data;
      try { data = JSON.parse(body); } catch (e) { setMsg("Bad data from server."); return; }
      setMsg(""); setTitle(data.title); render(data.todos || []);
    });
  }
  selectEl.onchange = function () {
    var id = selectEl.value;
    setMsg("Switching list...");
    selectEl.disabled = true;
    xhr("POST", "/api/selection" + Q + "&list=" + encodeURIComponent(id), function (status) {
      selectEl.disabled = false;
      if (status === 401) { if (reauth()) { selectEl.onchange(); } return; }
      if (status < 200 || status >= 300) { setMsg("Could not switch list (status " + status + ")."); return; }
      loadTodos();
    });
  };

  var initial = readUrlToken() || storedToken();
  if (!initial) { initial = promptToken("Enter access token:"); }
  if (initial) {
    setToken(initial);
    loadLists(function () { loadTodos(); }); // sequential: one request in flight
  } else {
    setMsg("Access token required. Reload to try again.");
  }
})();
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Page shell is static (no secrets). Serve it without a token so the page
    // itself can prompt for one and remember it; the API routes below still
    // require ?t=<TODO_TOKEN>.
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
      });
    }

    if (!authorized(url, env)) {
      return new Response("Unauthorized", { status: 401, headers: NO_STORE });
    }

    // Available lists + which one is currently served.
    if (path === "/api/lists") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      try {
        const [lists, selected] = await Promise.all([
          getProvider(env).lists(),
          getSelectedListId(env),
        ]);
        return Response.json({ lists, selected }, { headers: NO_STORE });
      } catch (err) {
        return Response.json({ error: errMessage(err) }, { status: errStatus(err), headers: NO_STORE });
      }
    }

    // Choose the list served to the Kindle. Validated against available lists.
    if (path === "/api/selection") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const listId = url.searchParams.get("list");
      if (!listId) return Response.json({ error: "Missing 'list'" }, { status: 400, headers: NO_STORE });
      try {
        const lists = await getProvider(env).lists();
        if (!lists.some((l) => l.id === listId)) {
          return Response.json({ error: "Unknown list" }, { status: 400, headers: NO_STORE });
        }
        if (!env.LIST_STORE) {
          return Response.json({ error: "LIST_STORE KV not configured" }, { status: 501, headers: NO_STORE });
        }
        await env.LIST_STORE.put(SELECTED_LIST_KEY, listId);
        invalidateTodos(ctx, listId); // serve the new list fresh on next poll
        return Response.json({ selected: listId }, { headers: NO_STORE });
      } catch (err) {
        return Response.json({ error: errMessage(err) }, { status: errStatus(err), headers: NO_STORE });
      }
    }

    // Full-screen PNG for the Kindle's non-interactive (image) mode.
    if (request.method === "GET" && path === "/todo.png") {
      // Resolve to either the list, a grace-period last-known-good list, or an
      // error screen — then render/etag/cache all three the same way.
      const listId = await getSelectedListId(env);
      let etag: string;
      let render: () => Promise<Response>;
      try {
        const data = await getData(env, ctx, listId);
        etag = await etagFor(data);
        render = () => renderTodoPng(data.todos, data.title, ctx);
      } catch (err) {
        const kind = classifyProviderError(err);
        const lkg = await getLastGood();
        if (lkg) {
          // Within the grace window: keep showing the last good list.
          etag = await etagFor(lkg);
          render = () => renderTodoPng(lkg.todos, lkg.title, ctx);
        } else {
          etag = await etagForString(`error:${kind}`);
          render = () => renderErrorPng(ERROR_SCREENS[kind], ctx);
        }
      }
      return servePng(request, url, ctx, etag, render);
    }

    // Rendered error screens, so the device can pre-download the ones it draws
    // itself when the Worker is unreachable (see scripts/kindle.sh deploy).
    const em = path.match(/^\/error\/([a-z]+)\.png$/);
    if (request.method === "GET" && em) {
      const kind = em[1] as ErrorKind;
      const screen = ERROR_SCREENS[kind];
      if (!screen) return new Response("Not Found", { status: 404, headers: NO_STORE });
      const etag = await etagForString(`error:${kind}`);
      return servePng(request, url, ctx, etag, () => renderErrorPng(screen, ctx));
    }

    // List (returns { title, todos }) for the currently served list.
    if (path === "/api/todos") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const listId = await getSelectedListId(env);
      return Response.json(await getData(env, ctx, listId), { headers: NO_STORE });
    }

    return new Response("Not Found", { status: 404, headers: NO_STORE });
  },
} satisfies ExportedHandler<Env>;

function errStatus(err: unknown): number {
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = Number((err as { status: unknown }).status);
    if (s >= 400 && s < 600) return s;
  }
  return 502; // backend/provider failure
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
