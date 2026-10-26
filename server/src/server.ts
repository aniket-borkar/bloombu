import { createServer, type Server } from "node:http";
import { registerAiRoutes } from "./ai/agent.js";
import { createDeepLlm, createLlm } from "./ai/index.js";
import { TOOLS } from "./ai/tools.js";
import { AlertService, registerAlertRoutes } from "./alerts/alerts.js";
import { createApp } from "./app.js";
import { AuthService } from "./auth/auth.js";
import { KvCache } from "./cache/kv.js";
import { ChatService } from "./chat/chat.js";
import { REPO_ROOT, type Config } from "./config.js";
import { HistoryCache } from "./history/cache.js";
import { loadPlugins } from "./plugins/loader.js";
import { registerPluginRoutes } from "./plugins/routes.js";
import { registerPortfolioRoutes } from "./portfolio/routes.js";
import { registerScenarioRoutes } from "./portfolio/scenario.js";
import { PortfolioService } from "./portfolio/service.js";
import { PortfolioStore } from "./portfolio/store.js";
import { PLUGIN_FACTORIES, createPlugins } from "./providers/index.js";
import { ProviderRouter } from "./providers/router.js";
import { registerBqlRoute } from "./research/bql.js";
import { FieldService, registerFieldRoutes } from "./research/fields.js";
import { registerMembersRoute } from "./research/members.js";
import { registerWirpRoute } from "./research/wirp.js";
import { registerForwardRoutes } from "./research/forwards.js";
import { registerSourcesRoute } from "./research/sources.js";
import { registerBriefRoute } from "./research/brief.js";
import { NotebookStore, registerNotebookRoutes } from "./research/notebooks.js";
import { registerValuationRoutes } from "./research/valuation.js";
import { StreamHub } from "./stream/hub.js";
import { Presence } from "./stream/presence.js";
import { TradeHub } from "./stream/trades.js";
import { PaperBroker, registerPaperRoutes } from "./trading/paper.js";
import { attachWebSocket } from "./stream/ws.js";
import { UserStore, registerDocRoutes } from "./userstore/store.js";

export interface TerminalServer {
  /** The API, the built client and the /ws WebSocket, not yet listening. */
  server: Server;
  /** Providers, plugins, AI and sign-in, for the startup log. */
  summary: string;
}

/**
 * Wire every service into one HTTP server and start the alert and paper-order
 * loops. The caller decides whether to listen on a port or hand the server to
 * a platform that routes requests to it.
 */
export async function createTerminalServer(config: Config): Promise<TerminalServer> {
  const extensions = await loadPlugins(
    config.plugins,
    { mock: config.providers.includes("mock"), env: process.env, log: console.log, cache: new KvCache(config.cacheDb) },
    { baseDir: REPO_ROOT, reservedProviders: Object.keys(PLUGIN_FACTORIES), reservedTools: TOOLS.map((t) => t.spec.name) },
  );
  const router = new ProviderRouter(createPlugins(config, PLUGIN_FACTORIES, console.warn, extensions.providers));
  const history = new HistoryCache(config.cacheDb, (s, i, from, to) => router.history(s, i, from, to));
  const chat = new ChatService(config.cacheDb);
  const portfolios = new PortfolioStore(config.cacheDb);
  const portfolioService = new PortfolioService(router, history);
  const hub = new StreamHub(router, config.streamIntervalMs);
  const fields = new FieldService(router);
  const llm = createLlm(config.ai);
  const deepLlm = createDeepLlm(config.ai, llm);
  const docs = new UserStore(config.cacheDb);
  const notebooks = new NotebookStore(config.cacheDb);
  const presence = new Presence();
  const alerts = new AlertService(config.cacheDb, router, history, (user, payload) => presence.sendTo(user, payload));
  const paper = new PaperBroker(config.cacheDb, router, portfolios, (user, payload) => presence.sendTo(user, payload));
  const auth = config.auth ? new AuthService(config.cacheDb, config.authSignupOpen) : null;
  const app = createApp({
    router,
    history,
    chat,
    auth,
    staticDir: config.staticDir,
    routes: [
      (a) => registerPortfolioRoutes(a, portfolios, portfolioService),
      (a) => registerScenarioRoutes(a, portfolios, portfolioService),
      (a) => registerValuationRoutes(a, router),
      (a) => registerNotebookRoutes(a, notebooks),
      (a) => registerFieldRoutes(a, fields),
      (a) => registerBqlRoute(a, { router, fields, portfolios }),
      (a) => registerDocRoutes(a, docs),
      (a) => registerAiRoutes(a, llm, { router, fields, history, portfolios, portfolioService, notebooks, now: Date.now, plugins: extensions, paper }, deepLlm),
      (a) => registerAlertRoutes(a, alerts),
      (a) => registerPaperRoutes(a, paper),
      (a) => registerPluginRoutes(a, extensions, router),
      (a) => registerMembersRoute(a, router),
      (a) => registerWirpRoute(a, router),
      (a) => registerForwardRoutes(a, router),
      (a) => registerSourcesRoute(a, { router, config, llm, plugins: extensions.plugins }),
      (a) => registerBriefRoute(a, { router, portfolios, portfolioService, alerts }),
    ],
  });

  const server = createServer(app);
  attachWebSocket(server, hub, {
    directKraken: router.streamingPlugin("XBTUSD Curncy")?.id === "kraken",
    chat,
    presence,
    trades: new TradeHub(router),
    authenticate: auth ? (req) => auth.userForRequest(req) : undefined,
  });
  alerts.start(config.streamIntervalMs);
  paper.start(config.streamIntervalMs);

  const plugins = extensions.plugins.map((p) => p.name).join(", ") || "none";
  return {
    server,
    summary: `providers: ${router.plugins.map((p) => p.id).join(", ")}; plugins: ${plugins}; AI: ${llm ? `${llm.name}/${llm.model}${deepLlm && deepLlm !== llm ? ` (deep: ${deepLlm.model})` : ""}` : "off"}; sign-in: ${auth ? "required" : "off"}`,
  };
}
