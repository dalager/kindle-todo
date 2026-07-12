#!/usr/bin/env python3
"""Kindle Todo — dependency-free server (stdlib only).

Serves a tiny todo page to the Kindle's native browser and acts as the private
endpoint the Complete buttons hit. Todos are persisted in todos.json next to
this file.

Routes:
  GET  /                        -> index.html
  GET  /api/todos               -> JSON array of todos
  POST /api/todos/{id}/complete -> mark todo done, persist, return the item

Run:  python3 server.py   (binds 0.0.0.0:8080)
"""

import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = 8200

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TODOS_PATH = os.path.join(BASE_DIR, "todos.json")
INDEX_PATH = os.path.join(BASE_DIR, "index.html")

_lock = threading.Lock()
_COMPLETE_RE = re.compile(r"^/api/todos/(\d+)/complete$")


def _read_todos():
    with open(TODOS_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_todos(todos):
    # Write to a temp file then replace, so a crash mid-write can't corrupt todos.json.
    tmp = TODOS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(todos, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, TODOS_PATH)


class Handler(BaseHTTPRequestHandler):
    server_version = "KindleTodo/1.0"

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # No caching: the e-ink display should always show current state.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, obj):
        self._send(status, json.dumps(obj), "application/json; charset=utf-8")

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            try:
                with open(INDEX_PATH, "rb") as fh:
                    body = fh.read()
            except OSError:
                self._send_json(500, {"error": "index.html missing"})
                return
            self._send(200, body, "text/html; charset=utf-8")
            return

        if self.path == "/api/todos":
            with _lock:
                try:
                    todos = _read_todos()
                except (OSError, ValueError):
                    self._send_json(500, {"error": "cannot read todos"})
                    return
            self._send_json(200, todos)
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        m = _COMPLETE_RE.match(self.path)
        if not m:
            self._send_json(404, {"error": "not found"})
            return

        todo_id = int(m.group(1))
        with _lock:
            try:
                todos = _read_todos()
            except (OSError, ValueError):
                self._send_json(500, {"error": "cannot read todos"})
                return

            found = None
            for t in todos:
                if t.get("id") == todo_id:
                    t["done"] = True
                    found = t
                    break

            if found is None:
                self._send_json(404, {"error": "no todo with id %d" % todo_id})
                return

            try:
                _write_todos(todos)
            except OSError:
                self._send_json(500, {"error": "cannot save todos"})
                return

        self._send_json(200, found)

    def log_message(self, fmt, *args):
        # Compact one-line access log.
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Kindle Todo serving on http://%s:%d  (todos: %s)" % (HOST, PORT, TODOS_PATH))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
