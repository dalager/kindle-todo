/**
 * Renders the current todo list to a full-screen PNG for the Kindle's
 * non-interactive (image) mode. Uses @cf-wasm/og (satori + resvg, no browser).
 *
 * Target panel: Kindle Voyage 1072 x 1448 px, grayscale. Black-on-white,
 * large type for 300ppi e-ink legibility.
 */
import React from "react";
import { ImageResponse, GoogleFont, cache } from "@cf-wasm/og/workerd";
import type { Todo } from "./providers/types";
import type { ErrorScreen } from "./errors";

export const KINDLE_W = 1072;
export const KINDLE_H = 1448;

export function renderTodoPng(todos: Todo[], title: string, ctx: ExecutionContext): Promise<Response> {
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
        {title || "Todo"}
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

/**
 * Renders a full-screen, centered error state (big emoji + headline + hint).
 * Used both live (backend failures) and to pre-bake the device's local
 * fallbacks. Emoji come from twemoji SVGs, dithered to grayscale on e-ink.
 */
export function renderErrorPng(screen: ErrorScreen, ctx: ExecutionContext): Promise<Response> {
  cache.setExecutionContext(ctx);

  const element = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        backgroundColor: "#ffffff",
        color: "#000000",
        fontFamily: "Inter",
        padding: "80px",
      }}
    >
      <div style={{ display: "flex", fontSize: 300, lineHeight: 1 }}>{screen.emoji}</div>
      <div style={{ display: "flex", fontSize: 68, fontWeight: 700, marginTop: 64, textAlign: "center" }}>
        {screen.title}
      </div>
      <div style={{ display: "flex", fontSize: 40, marginTop: 36, color: "#333333", maxWidth: 880, textAlign: "center" }}>
        {screen.body}
      </div>
    </div>
  );

  return ImageResponse.async(element, {
    width: KINDLE_W,
    height: KINDLE_H,
    format: "png",
    emoji: "twemoji",
    fonts: [new GoogleFont("Inter", { weight: 700 })],
  });
}
