# Discord roundtable bridge (Phase 1)

One Discord application posts into one explicitly allowlisted server and channel. It is a chat bridge, not a ninth Rakazo seat and not a replacement for Composio or any Slack plugin path.

Phase 1 converts agent text replies into Discord messages that can use Discord's documented message `tts` field. It does **not** transcribe human speech and does **not** join a voice channel.

## What it does

- Slash commands in the allowlisted guild/channel: `/ask` (one of FirstMate, Flux, Eleusis) and `/roundtable` (all three, one reply each).
- Replies go back to the originating channel or thread as the single Rakazo Discord app. Each reply has a speaker label in the text (`Flux: …`) plus a provenance footer. The app does not impersonate Discord users.
- Flux and Eleusis run through Rakazo's existing bot thread/run path (`trigger: discord`, system/meta message, `run.continue` job). FirstMate uses a typed external HTTP transport. If that URL is unset, the bridge says so and does not invent an answer or substitute another bot.
- Discord events are allowlisted, deduplicated by stable IDs, and ignored when they come from bots, so agent replies cannot start another agent turn.

A mention parser (`@app flux …`, `@app roundtable …`) exists for a later gateway increment. Phase 1's live surface is HTTP slash-command interactions, which do not need workspace-wide message ingestion.

## Configuration

All fields are optional as a group. Leave them unset to keep the bridge off. If any required Discord field is set, every required field must be set or the API refuses to start.

| Variable | Required when enabled | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Application bot token. Placeholder only in git. |
| `DISCORD_PUBLIC_KEY` | yes | Interactions public key (hex) for Ed25519 verification. |
| `DISCORD_APPLICATION_ID` | yes | Discord application id. |
| `DISCORD_GUILD_ID` | yes | Allowlisted guild. Traffic from other guilds is rejected. |
| `DISCORD_CHANNEL_ID` | yes | Allowlisted channel. Threads under this channel are accepted. |
| `DISCORD_WORKSPACE_ID` | yes | Rakazo workspace used to resolve Flux and Eleusis. |
| `DISCORD_FLUX_BOT_NAME` | no | Default `Flux`. |
| `DISCORD_ELEUSIS_BOT_NAME` | no | Default `Eleusis`. |
| `DISCORD_FLUX_BOT_ID` | no | Optional override if names collide. Do not hard-code a live org. |
| `DISCORD_ELEUSIS_BOT_ID` | no | Optional override if names collide. |
| `DISCORD_TTS_ENABLED` | no | Default `false`. When `true`, outbound replies set `tts: true`. |
| `DISCORD_AGENT_TIMEOUT_MS` | no | Default `180000`. |
| `DISCORD_REGISTER_COMMANDS` | no | Default `true`. Guild-scoped `/ask` and `/roundtable` overwrite. |
| `FIRSTMATE_TRANSPORT_URL` | no | If unset, FirstMate replies with an explicit unavailable message. |
| `FIRSTMATE_TRANSPORT_TOKEN` | no | Optional bearer token for the FirstMate URL. |
| `FIRSTMATE_TRANSPORT_TIMEOUT_MS` | no | Default `30000`. |

See `.env.example` for commented placeholders. Never commit a real token, public key, or `.env`.

## Discord app setup

These steps are for a human operator. This repository does not install the app into a live server, change OAuth, or deploy itself.

1. Create **one** Discord application. Do not create three bots or three Discord accounts.
2. Add a bot user. Reset and store the token only in the operator `.env` as `DISCORD_BOT_TOKEN`.
3. Copy the application's **Public Key** into `DISCORD_PUBLIC_KEY` and the application id into `DISCORD_APPLICATION_ID`.
4. Set the Interactions Endpoint URL to `https://<your-api-origin>/integrations/discord/interactions`. Discord will send a `PING`; the API answers `PONG` after signature verification.
5. Invite the app **only** to the intended guild, with the least privilege that still lets it use slash commands and post replies:

   - OAuth2 scopes: `bot` and `applications.commands`
   - Bot permissions: `View Channel` (1024), `Send Messages` (2048), `Send TTS Messages` (4096). Combined bitfield: `7168`.
   - Restrict the invite with `guild_id` and `disable_guild_select=true` when you already know the target server.

   Example URL shape (replace the application id and guild id):

   `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=7168&guild_id=GUILD_ID&disable_guild_select=true`

6. Grant the bot access only to the allowlisted channel.
7. Set `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, and `DISCORD_WORKSPACE_ID`. Restart the API yourself when you are ready. Command registration is guild-scoped, not global.

### Intents

Phase 1 receives slash commands over HTTP. No Gateway connection and no privileged intents are required. Do not enable Message Content Intent for this phase.

A later voice-channel reader or mention listener would need a Gateway client plus `Guilds` and `Guild Messages`. Reading human speech would additionally need voice receive and a speech-to-text pipeline that does not exist here. Mention text would need Message Content Intent. Even then, application code must keep the current guild/channel allowlist.

## Commands

- `/ask agent:<FirstMate|Flux|Eleusis> prompt:<text>` — one reply from that agent.
- `/roundtable prompt:<text>` — one reply each from FirstMate, Flux, and Eleusis.

Malformed commands get an ephemeral error. Unauthorized guilds or channels get an ephemeral rejection and are not dispatched.

## TTS, identity, and provenance

- Outbound messages keep the full text for accessibility and audit. A reply longer than Discord's 2000-character message limit is posted as sequential follow-ups instead of being cut off: the first carries the speaker label, embed, and provenance footer, and each continuation is prefixed `<speaker> (continued):` so it stays attributable without reading as a new speaker turn. Concatenating the chunk bodies reproduces the reply exactly.
- When `DISCORD_TTS_ENABLED=true`, those same messages set Discord's `tts` boolean. Discord only speaks TTS for users who have TTS enabled in their client. Editing a deferred loading message does not rely on TTS; each agent reply is a new follow-up so `tts` can take effect.
- Speaker identity is a text prefix and embed title (`FirstMate`, `Flux`, `Eleusis`). The Discord user is still the one Rakazo app.
- Provenance lives in the embed footer: `Rakazo Discord bridge · <speaker> · discord:interaction:<id> · not an impersonated Discord user`.

## Agent routing

- **Flux** and **Eleusis** are existing Rakazo bots, resolved from `DISCORD_WORKSPACE_ID` plus configured name and/or id. The bridge creates a `system` thread message (not a user message), a task, and a `discord`-triggered run, then enqueues the existing `run.continue` job. It does not post as the workspace owner.
- **FirstMate** is not a Rakazo bot. `FIRSTMATE_TRANSPORT_URL` is a typed outbound HTTP POST. Missing configuration, HTTP errors, and timeouts are returned as FirstMate-labeled failure text. The bridge will not fake a FirstMate answer, create a FirstMate seat, or silently send the prompt to Flux, Eleusis, or a human user identity.

Roundtable dispatch is bounded: one call and one Discord reply per selected agent. Partial failure still posts the successful replies and an honest error for the failed one.

## Failure modes

| Situation | Behavior |
| --- | --- |
| Discord fields only partly set | API process fails to start. |
| Discord unset | Bridge off. `POST /integrations/discord/interactions` returns 404. |
| Interaction body over the size cap | HTTP 413 before the body is buffered or verified. |
| Bad interaction signature | HTTP 401. Body is not processed. |
| Wrong guild or channel | Ephemeral reject. No agent turn. |
| Duplicate interaction or message id | Ignored. No second dispatch. |
| Bot/webhook authored event | Ignored so replies cannot loop. |
| FirstMate URL unset | Transparent unavailable reply from FirstMate. |
| FirstMate HTTP/timeout | Transparent transport error. No substitute agent. |
| Flux/Eleusis missing in the workspace | Transparent not-found reply for that speaker. |
| Agent timeout, pause, or failure | That speaker's Discord reply explains the failure. Others still post. |
| A speaker's backend throws | That speaker gets an honest failure reply. The other speakers' replies still post. |
| Discord refuses one reply post | The other speakers' replies still post, and one notice names only the speakers Discord refused. |
| Reply longer than Discord's 2000-character limit | Split across sequential follow-ups; nothing is truncated. |
| Discord refuses a later chunk of one reply | The chunks already posted stay, that speaker's remaining chunks are skipped, and one notice says their reply is cut short. |
| Discord 429 / 5xx on outbound posts | Adapter retries with `retry_after` / backoff. |
| Discord 404 on the first edit after the deferred ack | Retried with backoff; the ack always goes out before any webhook call. |
| Shutdown | New commands get 503. In-flight posts get a short drain. |

Agent work for a slash command starts only after the `type: 5` deferred acknowledgement has been handed back to Discord, so the first webhook call can never race the ack.

Info logs record event ids, speaker lists, and HTTP statuses. They do not record message bodies or credentials. Webhook paths are redacted before logging, because an interaction token is itself a credential.

## Later voice path

Discord I/O is isolated behind a typed adapter (`DiscordIO` plus an unimplemented `DiscordVoicePort`). A later increment can add voice-channel join/speak without changing `/ask`, `/roundtable`, FirstMate transport, or Flux/Eleusis run creation.

That later path is still not speech-to-text. Phase 1's TTS is "post text with `tts: true`". Joining a voice channel, playing audio frames, or transcribing humans remains out of scope until a later brief.

## Related code

- Adapter and bridge: `packages/adapters/src/discord/`
- HTTP mount: `apps/api/src/discord-route.ts`
- Env loading: `loadDiscordRoundtableConfig` and `apps/api/src/env.ts`
- Slack/Composio plugin paths are unchanged.
