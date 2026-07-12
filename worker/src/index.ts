/**
 * Kindle Todo — Cloudflare Worker.
 *
 * Serves the todo page, a JSON API, and a full-screen /todo.png render, backed
 * by a pluggable TodoProvider (currently Microsoft To Do). Access is gated by a
 * secret token in the URL (?t=...).
 *
 * Routes (all require a valid ?t=<TODO_TOKEN>):
 *   GET  /                          -> HTML page
 *   GET  /api/todos                 -> [{ id, text, done }]
 *   POST /api/todos/{id}/complete   -> mark done
 *   GET  /todo.png                  -> full-screen 1072x1448 PNG (Kindle image mode)
 *
 * The provider's list is cached briefly (LIST_CACHE_TTL) so the Kindle's ~15s
 * polling doesn't hammer the backend API; completing a task invalidates the
 * cache so the change shows on the next poll.
 */
import { renderTodoPng } from "./og";
import type { Todo } from "./providers/types";
import { createProvider, type ProviderEnv } from "./providers/factory";

interface Env extends ProviderEnv {
  TODO_TOKEN: string;
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Seconds to cache the provider's task list (bounds backend API calls). */
const LIST_CACHE_TTL = 30;
const LIST_CACHE_KEY = "https://todo.internal/list";

// Reuse the provider across requests in the same isolate so its in-memory
// access-token cache (and KV-backed refresh token) is shared.
let providerSingleton: ReturnType<typeof createProvider> | undefined;
function getProvider(env: Env) {
  return (providerSingleton ??= createProvider(env));
}

/** Provider list, served from the edge cache when fresh to limit API calls. */
async function getTodos(env: Env, ctx: ExecutionContext): Promise<Todo[]> {
  const cache = caches.default;
  const key = new Request(LIST_CACHE_KEY);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as Todo[];

  const todos = await getProvider(env).list();
  ctx.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(todos), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LIST_CACHE_TTL}` },
      }),
    ),
  );
  return todos;
}

function invalidateTodos(ctx: ExecutionContext): void {
  ctx.waitUntil(caches.default.delete(new Request(LIST_CACHE_KEY)));
}

// ETag = strong hash of the exact state that determines the rendered image.
async function etagFor(todos: Todo[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(todos));
  const digest = await crypto.subtle.digest("SHA-256", data);
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
  #list { list-style: none; margin: 0; padding: 0; }
  li { display: block; border-bottom: 2px solid #000; padding: 18px 20px; min-height: 64px; overflow: hidden; }
  .txt { font-size: 24px; line-height: 48px; float: left; max-width: 62%; }
  li.done .txt { text-decoration: line-through; color: #888; }
  button.complete { float: right; font-size: 22px; font-weight: bold; padding: 0 24px; height: 48px;
    line-height: 44px; background: #fff; color: #000; border: 3px solid #000;
    -webkit-appearance: none; border-radius: 0; }
  button.complete:active { background: #000; color: #fff; }
  li.done button.complete { display: none; }
  #msg { padding: 16px 20px; font-size: 20px; color: #444; }
</style>
</head>
<body>
  <h1>Todo</h1>
  <ul id="list"></ul>
  <div id="msg"></div>
<script type="text/javascript">
(function () {
  var listEl = document.getElementById("list");
  var msgEl = document.getElementById("msg");
  var Q = location.search; // carries ?t=<token>; reused on every API call

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
      var btn = document.createElement("button");
      btn.className = "complete";
      btn.appendChild(document.createTextNode("Complete"));
      btn.onclick = makeHandler(t.id, li);
      li.appendChild(span); li.appendChild(btn); listEl.appendChild(li);
    }
    if (visible === 0) {
      var d = document.createElement("li");
      d.appendChild(document.createTextNode("All done."));
      listEl.appendChild(d);
    }
  }
  function makeHandler(id, li) {
    return function () {
      li.className = "done";
      xhr("POST", "/api/todos/" + encodeURIComponent(id) + "/complete" + Q, function (status) {
        if (status < 200 || status >= 300) {
          li.className = "";
          setMsg("Could not complete (status " + status + "). Tap again.");
        } else { setMsg(""); }
      });
    };
  }
  function load() {
    setMsg("Loading...");
    xhr("GET", "/api/todos" + Q, function (status, body) {
      if (status !== 200) { setMsg("Could not load todos (status " + status + ")."); return; }
      var todos;
      try { todos = JSON.parse(body); } catch (e) { setMsg("Bad data from server."); return; }
      setMsg(""); render(todos);
    });
  }
  load();
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

    // Full-screen PNG for the Kindle's non-interactive (image) mode.
    if (request.method === "GET" && path === "/todo.png") {
      const todos = await getTodos(env, ctx);
      const etag = await etagFor(todos);

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
        const rendered = await renderTodoPng(todos, ctx);
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

    // List
    if (path === "/api/todos") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return Response.json(await getTodos(env, ctx), { headers: NO_STORE });
    }

    // Complete
    const m = path.match(/^\/api\/todos\/([^/]+)\/complete$/);
    if (m) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const id = decodeURIComponent(m[1]);
      try {
        await getProvider(env).complete(id);
      } catch (err) {
        const status = errStatus(err);
        return Response.json({ error: errMessage(err) }, { status, headers: NO_STORE });
      }
      invalidateTodos(ctx); // reflect the completion on the next poll
      return Response.json({ id, done: true }, { headers: NO_STORE });
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
