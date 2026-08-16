import { type ConnectorTool, DEFAULT_MEMORY_PATH } from "@rakazo/adapter-kit";

/**
 * Memory is rendered to the model under a scope, and models copy that scope back into the
 * path. Naming the shape explicitly, with examples and a stated default, keeps `path` from
 * being a bare pass-through string.
 */
const MEMORY_PATH_SCHEMA = {
  type: "string",
  description: `Relative path of the memory document, defaulting to "${DEFAULT_MEMORY_PATH}". Use the path exactly as it appears in the memory heading, with no scope prefix and no spaces or colons.`,
  examples: [DEFAULT_MEMORY_PATH, "profile.md", "history/digest.md", "relationships.md"],
  default: DEFAULT_MEMORY_PATH,
} as const;

export const DELEGATION_TOOL_NAMES = new Set([
  "run_subagent",
  "spawn_bot",
  "archive_bot",
  "delete_bot",
]);

/**
 * Tools an in-turn subagent must not have. Delegation is excluded because a helper
 * that dies with the turn should not create or destroy bots; `send_to_bot` is excluded
 * because a note it sent would be attributed to the bot that hosts it, not to the
 * helper. `send_to_bot` is deliberately not a delegation tool: it messages an existing
 * peer and never spawns anything.
 */
export const SUBAGENT_EXCLUDED_TOOL_NAMES = new Set([...DELEGATION_TOOL_NAMES, "send_to_bot"]);

export const builtinAgentTools: ConnectorTool[] = [
  {
    name: "computer_observe",
    description:
      "Capture the current screen of this bot's computer. Returns frame metadata and an image. Observe before coordinate-based actions and whenever another actor may have changed the desktop.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_act",
    description:
      "Perform up to 24 ordered desktop actions on this bot's computer and return the resulting screen. Batch only predictable actions; stop before an outcome you need to inspect. Action kinds: click, move, down, up, type, key, scroll, wait.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["click", "move", "down", "up", "type", "key", "scroll", "wait"],
              },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              double: { type: "boolean" },
              text: { type: "string" },
              key: { type: "string" },
              modifiers: { type: "array", items: { type: "string" } },
              direction: { type: "string", enum: ["up", "down"] },
              amount: { type: "number" },
              ms: { type: "number" },
            },
            required: ["kind"],
          },
        },
        observe: { type: "boolean" },
        settle_ms: { type: "number" },
      },
      required: ["actions"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories in this bot's home. On a Team Computer, relative paths use the bot folder; use shared/... for shared work or bots/... to inspect the Team root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from this bot's home. On a Team Computer, relative paths use the bot folder and shared/... accesses shared work. Open visual or binary files with open_path instead.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a UTF-8 file into this bot's home. On a Team Computer, relative paths use the bot folder; use shared/... only for work other bots should share.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "shell",
    description:
      "Run a command inside this bot's computer. cwd defaults to the bot's folder on a Team Computer and the workspace root on a Private Computer.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "open_path",
    description:
      "Open a workspace file or an http(s) URL in its default graphical application on this bot's computer and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "launch_app",
    description:
      "Launch an installed graphical application on this bot's computer, optionally with a URI, and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: {
        application: { type: "string" },
        uri: { type: "string" },
      },
      required: ["application"],
    },
  },
  {
    name: "request_takeover",
    description:
      "Ask the user to take over the computer screen for login or human judgment. Protected input stays off the thread.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "remember",
    description:
      "Add one durable fact to this bot's explicit memory. The fact is appended to the document and everything already stored there is kept, so send only the new fact, never the whole document. An exact repeat of a fact already stored is ignored. To correct or rewrite a document as a whole, use replace_memory_document instead.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The single new fact to store, as plain text or one markdown bullet.",
        },
        path: MEMORY_PATH_SCHEMA,
      },
      required: ["content"],
    },
  },
  {
    name: "replace_memory_document",
    description:
      "Overwrite an entire memory document with new content. Everything currently stored at that path is discarded, so send the complete document, not one fact. Use this only to rewrite or correct memory as a whole; to store a newly-learned fact use remember.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "The complete replacement document. Any existing fact you still want kept must appear here.",
        },
        path: MEMORY_PATH_SCHEMA,
      },
      required: ["content", "path"],
    },
  },
  {
    name: "run_subagent",
    description:
      "Run a short-lived helper inside this turn only. It is not a bot: no list entry, no thread, no computer of its own, and it disappears when this turn ends. Never call this because the user asked to create a bot — that is spawn_bot, and spawn_bot alone.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short label shown in the thread, e.g. scout or reviewer.",
        },
        task: { type: "string", description: "The work the helper should complete." },
        instructions: {
          type: "string",
          description: "Optional extra system instructions for the helper.",
        },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "spawn_bot",
    description:
      "Create a full, regular bot — the same kind the user creates from the + button. It gets its own thread, computer, and memory, and appears as a peer in the bot list. Do not also call run_subagent. Creating the bot is the whole action. Only set prompt if the user asked that new bot to start work immediately.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        instructions: { type: "string" },
        prompt: {
          type: "string",
          description: "Optional first task to run in the new bot's thread.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "send_to_bot",
    description:
      "Send a short note to a bot that already exists, by bot_id or exact name. The note appears as one line in both chats and the other bot wakes up on its own thread to read it. This never creates a bot — that is spawn_bot — and it does not show you the other bot's conversation.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: {
          type: "string",
          description: "Id of the bot to notify. Use this when you have it.",
        },
        name: {
          type: "string",
          description:
            "Exact, case-sensitive name of the bot to notify. Used only when bot_id is omitted.",
        },
        text: {
          type: "string",
          description:
            "The note. Keep it to what the other bot needs — this is a line, not a transcript.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "archive_bot",
    description:
      "Archive a bot this bot created. Archiving stops its work and routines, hides it from the active list, and preserves its conversation, memory, and files for the user to restore or delete later. confirm_name must exactly match its name. This cannot archive you, bots the user created, or bots another bot created.",
    inputSchema: {
      type: "object",
      properties: {
        confirm_name: { type: "string", description: "Exact current name of the bot to archive." },
        bot_id: {
          type: "string",
          description:
            "Optional bot id. If omitted, the unique bot this bot created with confirm_name is archived.",
        },
      },
      required: ["confirm_name"],
    },
  },
];
