#!/usr/bin/env node
/**
 * Redact captured agy stdout/stderr for the public fixture tree.
 * Replaces conversation ids, emails, host paths, usernames, and token-shaped
 * strings. Does not read ~/.gemini or any agy internal store.
 */
import { readFileSync, writeFileSync } from "node:fs";

const caseName = process.argv[2];
if (!caseName) {
  process.stderr.write(
    "usage: redact-agy-fixture.mjs <case-name> <events-in> <stderr-in> <events-out> <stderr-out>\n",
  );
  process.exit(2);
}

const [, , , eventsIn, stderrIn, eventsOut, stderrOut] = process.argv;
const conversation = `fixture-conversation-${caseName}`;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const HOME = /\/home\/[A-Za-z0-9._-]+/g;
const USERS = /\/(?:Users|mnt\/c\/Users)\/[A-Za-z0-9._-]+/g;
const WIN = /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g;
const TREEHOUSE = /\/[^\s"'\\]*treehouse[^\s"'\\]*/gi;
const FIRSTMATE = /\/[^\s"'\\]*firstmate[^\s"'\\]*/gi;
const GEMINI = /\/[^\s"'\\]*\.gemini[^\s"'\\]*/gi;
const OAUTH_URL = /https:\/\/accounts\.google\.com\/[^\s]+/gi;
const GOOGLE_CLIENT = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/gi;
const BEARER = /\b(?:Bearer|token)\s+[A-Za-z0-9._\-+=/]+/gi;
const GOOGLE = /\bya29\.[A-Za-z0-9._-]+/g;
const API_KEY = /\b(?:AIza|sk-|xox[baprs]-)[A-Za-z0-9._-]+/g;

function redactString(value) {
  return value
    .replace(OAUTH_URL, "https://accounts.example.invalid/device")
    .replace(GOOGLE_CLIENT, "fixture.apps.googleusercontent.com")
    .replace(EMAIL, "fixture@example.invalid")
    .replace(UUID, conversation)
    .replace(WIN, String.raw`C:\Users\fixture`)
    .replace(USERS, "/Users/fixture")
    .replace(TREEHOUSE, "/fixture/worktree")
    .replace(FIRSTMATE, "/fixture/firstmate")
    .replace(GEMINI, "/fixture/.gemini")
    .replace(HOME, "/home/fixture")
    .replace(BEARER, "Bearer fixture-token")
    .replace(GOOGLE, "ya29.fixture-token")
    .replace(API_KEY, "fixture-api-key");
}

function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "conversation_id" || key === "conversationId" || key === "conversation") &&
        typeof child === "string" &&
        child.trim()
      ) {
        out[key] = conversation;
      } else {
        out[key] = redactValue(child);
      }
    }
    return out;
  }
  return value;
}

function redactEvents(text) {
  const trimmed = text.trim();
  if (!trimmed) return text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return `${JSON.stringify(redactValue(parsed))}\n`;
    }
  } catch {
    // NDJSON, or a JSON value that is not a single document.
  }
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    try {
      out.push(JSON.stringify(redactValue(JSON.parse(line))));
    } catch {
      out.push(redactString(line));
    }
  }
  return text.endsWith("\n") ? `${out.join("\n")}` : `${out.join("\n")}\n`;
}

writeFileSync(eventsOut, redactEvents(readFileSync(eventsIn, "utf8")));
writeFileSync(stderrOut, redactString(readFileSync(stderrIn, "utf8")));
