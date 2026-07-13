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
 * Routes (all require a valid ?t=<TODO_TOKEN>):
 *   GET  /                -> HTML page (list picker + tasks)
 *   GET  /api/lists       -> { lists: [{ id, name }], selected }
 *   POST /api/selection   -> set the served list (?list=<id>); { selected }
 *   GET  /api/todos       -> { title, todos }
 *   GET  /todo.png        -> full-screen 1072x1448 PNG (Kindle image mode)
 *
 * The served list is cached briefly (LIST_CACHE_TTL) so the Kindle's ~15s
 * polling doesn't hammer the backend API; changing the selection invalidates
 * the cache so the switch shows on the next poll. Completing a task is done in
 * the upstream To Do app, not here.
 */
import { renderTodoPng } from "./og";
import type { Todo } from "./providers/types";
import { createProvider, type ProviderEnv } from "./providers/factory";

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
  return data;
}

function invalidateTodos(ctx: ExecutionContext, listId: string): void {
  ctx.waitUntil(caches.default.delete(listCacheKey(listId)));
}

// ETag = strong hash of the exact state that determines the rendered image
// (title + tasks), so a list rename, list switch, or task change flips it.
async function etagFor(data: TodoData): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
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
  var Q = location.search; // carries ?t=<token>; reused on every API call

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
  function loadLists() {
    xhr("GET", "/api/lists" + Q, function (status, body) {
      if (status !== 200) { return; }
      var data;
      try { data = JSON.parse(body); } catch (e) { return; }
      var lists = data.lists || [];
      selectEl.innerHTML = "";
      for (var i = 0; i < lists.length; i++) {
        var opt = document.createElement("option");
        opt.value = lists[i].id;
        opt.appendChild(document.createTextNode(lists[i].name));
        if (lists[i].id === data.selected) { opt.selected = true; }
        selectEl.appendChild(opt);
      }
    });
  }
  function loadTodos() {
    setMsg("Loading...");
    xhr("GET", "/api/todos" + Q, function (status, body) {
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
      if (status < 200 || status >= 300) { setMsg("Could not switch list (status " + status + ")."); return; }
      loadTodos();
    });
  };
  loadLists();
  loadTodos();
})();
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!authorized(url, env)) {
      return new Response("Unauthorized", { status: 401, headers: NO_STORE });
    }

    // Page
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
      });
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
      const listId = await getSelectedListId(env);
      const data = await getData(env, ctx, listId);
      const etag = await etagFor(data);

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
        const rendered = await renderTodoPng(data.todos, data.title, ctx);
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
