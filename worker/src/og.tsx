/**
 * Renders the current todo list to a full-screen PNG for the Kindle's
 * non-interactive (image) mode. Uses @cf-wasm/og (satori + resvg, no browser).
 *
 * Target panel: Kindle Voyage 1072 x 1448 px, grayscale. Black-on-white,
 * large type for 300ppi e-ink legibility.
 */
import React from "react";
import { ImageResponse, GoogleFont, cache } from "@cf-wasm/og/workerd";

export const KINDLE_W = 1072;
export const KINDLE_H = 1448;

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export function renderTodoPng(todos: Todo[], ctx: ExecutionContext): Promise<Response> {
  // Lets the library reuse fetched fonts across requests.
  cache.setExecutionContext(ctx);

  const pending = todos.filter((t) => !t.done);

  const element = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: "#ffffff",
        color: "#000000",
        fontFamily: "Inter",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 72,
          fontWeight: 700,
          padding: "40px 56px",
          borderBottom: "6px solid #000000",
        }}
      >
        Todo
      </div>

      {pending.length === 0 ? (
        <div style={{ display: "flex", fontSize: 52, padding: "56px" }}>All done.</div>
      ) : (
        pending.map((t) => (
          <div
            key={t.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              fontSize: 48,
              lineHeight: 1.25,
              padding: "32px 56px",
              borderBottom: "3px solid #000000",
            }}
          >
            {/* open checkbox glyph + text */}
            <div style={{ display: "flex", marginRight: 28 }}>▢</div>
            <div style={{ display: "flex", flex: 1 }}>{t.text}</div>
          </div>
        ))
      )}
    </div>
  );

  return ImageResponse.async(element, {
    width: KINDLE_W,
    height: KINDLE_H,
    format: "png",
    fonts: [new GoogleFont("Inter", { weight: 700 })],
  });
}
