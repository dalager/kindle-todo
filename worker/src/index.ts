/**
 * Kindle Todo — Cloudflare Worker.
 *
 * Serves the todo page and its API, backed by D1 (strong consistency).
 * Access is gated by a secret token in the URL (?t=...), since this is a
 * public Worker replacing the old LAN-private server. The HTML page reads the
 * token from its own query string and forwards it on every API call.
 *
 * Routes (all require a valid ?t=<TODO_TOKEN>):
 *   GET  /                          -> HTML page
 *   GET  /api/todos                 -> [{ id, text, done }]
 *   POST /api/todos/{id}/complete   -> mark done, return the row
 */

import { renderTodoPng, type Todo } from "./og";

interface Env {
  DB: D1Database;
  TODO_TOKEN: string;
}

const NO_STORE = { "Cache-Control": "no-store" };

// ES5 + XMLHttpRequest page for the ancient Kindle Voyage WebKit browser.
// It reuses its own query string (which carries ?t=<token>) on API calls.
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
      li.id = "todo-" + t.id;
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
      xhr("POST", "/api/todos/" + id + "/complete" + Q, function (status) {
        if (status < 200 || status >= 300) {
          li.className = "";
          setMsg("Could not complete #" + id + " (status " + status + "). Tap again.");
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

function authorized(url: URL, env: Env): boolean {
  const t = url.searchParams.get("t");
  return !!env.TODO_TOKEN && t === env.TODO_TOKEN;
}

interface TodoRow { id: number; text: string; done: number; }

async function getTodos(env: Env): Promise<Todo[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, text, done FROM todos ORDER BY id"
  ).all<TodoRow>();
  return results.map((r) => ({ id: r.id, text: r.text, done: !!r.done }));
}

// ETag = strong hash of the exact state that determines the rendered image.
// Any todo change flips it; identical state keeps it stable across polls.
async function etagFor(todos: Todo[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(todos));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

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
    // Conditional GET: cheap 304 when unchanged; render (once per change,
    // via Cache API) only when the state hash flips.
    if (request.method === "GET" && path === "/todo.png") {
      const todos = await getTodos(env);
      const etag = await etagFor(todos);

      // Client already has the current image -> tiny 304, no render, no redraw.
      if (request.headers.get("If-None-Match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": "no-cache" },
        });
      }

      // Serve the render for this exact state from the edge cache if present,
      // so we rasterize at most once per distinct state.
      const cache = caches.default;
      const cacheKey = new Request(new URL(`/__png/${etag.slice(1, -1)}`, url.origin).toString());
      let body: ArrayBuffer;
      const hit = await cache.match(cacheKey);
      if (hit) {
        body = await hit.arrayBuffer();
      } else {
        const rendered = await renderTodoPng(todos, ctx);
        body = await rendered.arrayBuffer();
        // Store immutably: the key already encodes the state hash.
        ctx.waitUntil(
          cache.put(
            cacheKey,
            new Response(body, {
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=31536000, immutable",
              },
            })
          )
        );
      }

      // Client copy: revalidate every poll (no-cache) and carry the ETag so the
      // next poll can 304.
      return new Response(body, {
        headers: {
          "Content-Type": "image/png",
          ETag: etag,
          "Cache-Control": "no-cache",
        },
      });
    }

    // List
    if (path === "/api/todos") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return Response.json(await getTodos(env), { headers: NO_STORE });
    }

    // Complete
    const m = path.match(/^\/api\/todos\/(\d+)\/complete$/);
    if (m) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const id = Number(m[1]);
      const res = await env.DB.prepare("UPDATE todos SET done = 1 WHERE id = ?").bind(id).run();
      if (!res.meta.changes) {
        return Response.json({ error: `no todo with id ${id}` }, { status: 404, headers: NO_STORE });
      }
      const row = await env.DB.prepare(
        "SELECT id, text, done FROM todos WHERE id = ?"
      ).bind(id).first<TodoRow>();
      return Response.json({ id: row!.id, text: row!.text, done: !!row!.done }, { headers: NO_STORE });
    }

    return new Response("Not Found", { status: 404, headers: NO_STORE });
  },
} satisfies ExportedHandler<Env>;
