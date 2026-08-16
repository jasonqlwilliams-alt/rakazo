import type { ComputerMode } from "@rakazo/contracts";

/**
 * `description` is the short blurb shown next to a bot. `instructions` is its persona, the
 * system prompt the run is built from. They are different fields and neither is a default
 * for the other: sending the description as the instructions replaces a 1,900-2,500 byte
 * persona with a 31-52 byte blurb, which is how eight live seats lost theirs.
 *
 * Both payloads are built here so no screen can cross the two fields by hand.
 */

export interface BotDraft {
  name: string;
  title: string;
  description: string;
  computerMode: ComputerMode;
}

export interface BotSettingsDraft {
  name: string;
  title: string;
  description: string;
}

/**
 * A new bot gets its instructions from its seed or not at all. The field is omitted rather
 * than defaulted from the description; a bot with no instructions already falls back to its
 * name, title, and description when a run is built.
 */
export function botCreateInput(draft: BotDraft) {
  return {
    name: draft.name.trim(),
    title: draft.title,
    description: draft.description,
    notifyOnFinish: true,
    computerMode: draft.computerMode,
  };
}

/**
 * The settings panel edits name, title, and description. It has no instructions editor, so
 * it sends no instructions field and the stored persona is left exactly as it was.
 */
export function botSettingsPatch(draft: BotSettingsDraft) {
  return {
    name: draft.name,
    title: draft.title,
    description: draft.description,
  };
}
