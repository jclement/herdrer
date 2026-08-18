import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * These assert a security property against the shipped service worker source,
 * not against a mock.
 *
 * The bug they exist to prevent was real and was seen in production: the worker
 * cached /api/v1/review network-first with a fallback, so a phone that had once
 * been logged in rendered a sidebar of open review titles to whoever opened it
 * next — no session, no request to the server. A Cache Storage entry carries no
 * notion of who it was fetched for, so serving one answers an authorisation
 * question that only the server can answer.
 */
const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

describe("service worker caching", () => {
  it("never caches an API response", () => {
    expect(sw).not.toMatch(/["'`]\/api\/v1\/review/);
    expect(sw).not.toMatch(/["'`]\/api\/v1\/bootstrap/);
    // The bail-out for /api/ must exist and must come before any respondWith.
    const apiBail = sw.indexOf('url.pathname.startsWith("/api/")');
    expect(apiBail).toBeGreaterThan(-1);
    expect(apiBail).toBeLessThan(sw.indexOf("event.respondWith"));
  });

  it("has no network-first data cache at all", () => {
    // Strip comments before asserting: the activate handler documents the cache
    // it deletes by name, and that prose is worth keeping.
    const code = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/networkFirst/);
    expect(code).not.toMatch(/herdrer-data-/);
    expect(code).not.toMatch(/DATA_TIMEOUT_MS/);
  });

  it("does not cache the sandboxed review document", () => {
    expect(sw).toMatch(/pathname\.endsWith\("\/render"\)/);
  });

  it("purges non-current caches on activate, so an old data cache is dropped", () => {
    expect(sw).toMatch(/caches\.delete/);
    expect(sw).toMatch(/VERSION = "v2"/);
  });

  it("accepts an explicit purge message, because activation is lazy", () => {
    expect(sw).toMatch(/herdrer:purge/);
  });

  it("still caches the shell, which holds no data", () => {
    expect(sw).toMatch(/cacheFirst\(request, SHELL\)/);
  });
});
