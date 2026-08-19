import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  JobPublisher,
  ManagedConnectorProvider,
  RealtimeFanout,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  type ComposioProvider,
  type ConnectorRegistry,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createRunExecutor,
  createRunSandbox,
  type DestinationEmulator,
  destroyBot,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  isComposioEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  MAX_INBOX_IMAGE_BYTES,
  MAX_INBOX_IMAGE_COUNT,
  MAX_INBOX_IMAGE_TOTAL_BYTES,
  McpConnector,
  McpOAuthBroker,
  PiAgentRuntime,
  PiOAuthLogins,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  pushTokenPath,
  type RemoteConnectorDependencies,
  ScriptedAgentRuntime,
  storeBotInboxImages,
  toComputerRef,
  WorkspaceMemoryProviderResolver,
} from "@rakazo/adapters";
import { blockedAuthPaths, createAuth } from "@rakazo/auth";
import {
  createDb,
  createThreadEvents,
  type PrismaClient,
  parseComputerMode,
  requireMembership,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type AppEnv, loadEnv } from "./env.js";
import { createRouter } from "./router.js";
import { mountVoiceHttpRoutes } from "./voice.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  connector: DestinationEmulator;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  executor: ReturnType<typeof createRunExecutor>;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    composio?: ComposioProvider;
    pipedream?: ManagedConnectorProvider;
    remoteConnectors?: RemoteConnectorDependencies;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    composio: composioOverride,
    pipedream: pipedreamOverride,
    remoteConnectors,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl);
  const { prisma } = created;
  created.pool?.on("error", () => undefined);
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const events = createThreadEvents(prisma, realtime);
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs = inMemoryJobs ?? new GraphileJobPublisher(env.databaseUrl);
  const sandbox: SandboxProvider = createRunSandbox(env.sandboxProvider, {
    supervisorUrl: env.sandboxSupervisorUrl,
    supervisorToken: env.sandboxSupervisorToken,
    e2bApiKey: env.e2bApiKey,
    daytonaApiKey: env.daytonaApiKey,
    daytonaApiUrl: env.daytonaApiUrl,
    daytonaTarget: env.daytonaTarget,
    boxApiKey: env.boxApiKey,
    boxApiUrl: env.boxApiUrl,
    dataDir: env.dataDir,
    prisma,
  });
  const secrets = new EncryptedSecretStore(env.encryptionKey);
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, remoteConnectors);
  const memoryProviders = new WorkspaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      network: remoteConnectors,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    pipedreamOverride ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  const installed = new InstalledConnectorProvider(prisma, secrets, remoteConnectors);
  const stack = createConnectorStack(isComposioEnabled(env.composioApiKey), composioOverride, [
    installed,
    ...(pipedream ? [pipedream] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  void stack.composio?.warmDirectory().catch(() => undefined);
  void pipedream?.warmDirectory?.().catch(() => undefined);
  const runtime =
    env.agentRuntime === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const notifications = new ExpoPushProvider(env.dataDir);
  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    extraOrigins: [
      "rakazo://",
      "exp://",
      "exp://*",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost:19006",
      "http://127.0.0.1:19006",
    ],
    beforeDeleteUser: async (userId) => {
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, workspaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            { prisma, sandbox, home, jobs, artifacts, dataDir: env.dataDir },
            bot,
            {
              operationId: `account-delete:${userId}`,
              traceId: `account-delete:${userId}`,
              workspaceId: bot.workspaceId,
              userId,
              botId: bot.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true },
          ),
        ),
      );
      await rm(pushTokenPath(env.dataDir, userId), { force: true }).catch(() => undefined);
    },
  });
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory,
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [env.openRouterKey ?? "", env.composioApiKey ?? ""].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey: env.openRouterKey,
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: "api",
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey: env.openRouterKey,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs ? createJobReconciler({ prisma, jobs }) : undefined;
  reconciler?.start();

  const router = createRouter({
    prisma,
    events,
    auth,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    home,
    secrets,
    oauthLogins,
    mcpOAuth,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    env: {
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      openRouterKey: env.openRouterKey,
      webOrigin: env.webOrigin,
      screenProxySecret: env.authSecret,
      sandboxProvider: env.sandboxProvider,
    },
  });
  const rpc = new RPCHandler(router);
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (blockedAuthPaths.some((blocked) => path.startsWith(blocked))) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    return auth.handler(c.req.raw);
  });
  app.post("/api/desktop-files", async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id).catch(() => null)
      : null;
    if (!actor) return c.json({ error: "Sign in to attach photos" }, 401);

    try {
      const form = await c.req.raw.formData();
      const botId = String(form.get("botId") ?? "");
      const bot = await prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId, archivedAt: null },
        include: { computer: true },
      });
      if (!bot) return c.json({ error: "Bot not found" }, 404);
      if (!bot.computer?.providerRef) {
        return c.json({ error: "Open the bot computer before attaching photos" }, 409);
      }

      const selected = form.getAll("files").filter(isUploadedFile);
      if (selected.length === 0) return c.json({ error: "Choose at least one image" }, 400);
      if (selected.length > MAX_INBOX_IMAGE_COUNT) {
        return c.json(
          { error: `Choose no more than ${MAX_INBOX_IMAGE_COUNT} images at once` },
          400,
        );
      }
      let total = 0;
      for (const file of selected) {
        if (file.size > MAX_INBOX_IMAGE_BYTES) {
          return c.json({ error: `${file.name || "Photo"} is larger than 25 MB` }, 413);
        }
        total += file.size;
      }
      if (total > MAX_INBOX_IMAGE_TOTAL_BYTES) {
        return c.json({ error: "The selected images are larger than 100 MB together" }, 413);
      }

      const context = {
        operationId: `desktop-files:${randomUUID()}`,
        traceId: `desktop-files:${bot.id}`,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        botId: bot.id,
        signal: c.req.raw.signal,
      };
      const files = await storeBotInboxImages(
        { home, sandbox },
        {
          botId: bot.id,
          homeKey: bot.computer.homeKey,
          mode: parseComputerMode(bot.computer.scope),
          computer: toComputerRef(bot.computer),
          files: await Promise.all(
            selected.map(async (file) => ({
              name: file.name,
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          ),
        },
        context,
      );
      return c.json({ files });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not attach photos";
      if (/image|choose|larger than/i.test(message)) return c.json({ error: message }, 400);
      console.error("desktop photo copy", error);
      return c.json({ error: "Could not copy photos into the bot home" }, 500);
    }
  });
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id).catch(() => null)
      : null;
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { actor, signal: c.req.raw.signal },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    if (!session?.user) return null;
    return requireMembership(prisma, session.user.id).catch(() => null);
  });
  app.get("/health", (c) =>
    c.json({
      ok: true,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: Boolean(stack.composio),
      pipedream: Boolean(pipedream),
      jobs: jobKind,
      realtime: realtime.describe().id,
      revision: env.gitSha ?? null,
    }),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connector,
    composio: stack.composio,
    connectors: stack.connector,
    executor,
    stop: async () => {
      oauthLogins.abortAll();
      await reconciler?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
    },
  };
}

function isUploadedFile(value: unknown): value is File {
  return (
    typeof value !== "string" &&
    Boolean(value) &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function isTrustedOrigin(origin: string, env: AppEnv) {
  if (!origin) return true;
  if (origin === env.webOrigin || origin === env.apiUrl || origin === env.authUrl) return true;
  if (origin.startsWith("rakazo://") || origin.startsWith("exp://")) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}
