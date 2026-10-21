import {
  DISCORD_CONTENT_LIMIT,
  type DiscordCorrelation,
  type DiscordOutboundMessage,
  type RoundtableSpeaker,
  SPEAKER_LABELS,
} from "./types.js";

export function speakerLabel(speaker: RoundtableSpeaker): string {
  return SPEAKER_LABELS[speaker];
}

export function formatAgentMessages(input: {
  speaker: RoundtableSpeaker;
  text: string;
  correlation: DiscordCorrelation;
  ttsEnabled: boolean;
}): DiscordOutboundMessage[] {
  const label = speakerLabel(input.speaker);
  const body = input.text.trim() || "(no text reply)";
  const firstPrefix = `${label}: `;
  const restPrefix = `${label} (continued): `;
  const parts = splitBody(
    body,
    DISCORD_CONTENT_LIMIT - firstPrefix.length,
    DISCORD_CONTENT_LIMIT - restPrefix.length,
  );
  return parts.map((part, index) => ({
    content: `${index === 0 ? firstPrefix : restPrefix}${part}`,
    tts: input.ttsEnabled,
    embeds:
      index === 0
        ? [
            {
              title: label,
              footer: {
                text: provenanceLine(input.speaker, input.correlation),
              },
            },
          ]
        : undefined,
    allowedMentions: { parse: [] },
  }));
}

export function formatBridgeNotice(text: string, ttsEnabled = false): DiscordOutboundMessage {
  return {
    content: truncateContent(`Rakazo: ${text}`),
    tts: ttsEnabled,
    allowedMentions: { parse: [] },
  };
}

export function provenanceLine(
  speaker: RoundtableSpeaker,
  correlation: DiscordCorrelation,
): string {
  const eventRef =
    correlation.eventKind === "interaction"
      ? `discord:interaction:${correlation.interactionId ?? correlation.eventId}`
      : `discord:message:${correlation.messageId ?? correlation.eventId}`;
  return `Rakazo Discord bridge · ${speakerLabel(speaker)} · ${eventRef} · not an impersonated Discord user`;
}

export function ackText(speakers: RoundtableSpeaker[]): string {
  const names = speakers.map(speakerLabel);
  if (names.length === 1) return `Asking ${names[0]}.`;
  if (names.length === 2) return `Asking ${names[0]} and ${names[1]}.`;
  return `Asking ${names.slice(0, -1).join(", ")}, and ${names.at(-1)}.`;
}

function truncateContent(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  const suffix = "\n…(truncated)";
  return content.slice(0, DISCORD_CONTENT_LIMIT - suffix.length) + suffix;
}

function splitBody(body: string, firstBudget: number, restBudget: number): string[] {
  const parts: string[] = [];
  let rest = body;
  let budget = firstBudget;
  while (rest.length > budget) {
    const cut = breakPoint(rest, budget);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    budget = restBudget;
  }
  parts.push(rest);
  return parts;
}

function breakPoint(text: string, budget: number): number {
  const window = text.slice(0, budget);
  const newline = window.lastIndexOf("\n");
  if (newline > 0) return newline + 1;
  const space = window.lastIndexOf(" ");
  if (space > 0) return space + 1;
  return budget;
}
