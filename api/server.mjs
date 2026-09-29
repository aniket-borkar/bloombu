import { loadConfig } from "../server/dist/config.js";
import { createTerminalServer } from "../server/dist/server.js";

// Vercel Functions can only write to /tmp, which lasts only as long as the function instance.
const config = loadConfig({ ...process.env, CACHE_DB: process.env.CACHE_DB || "/tmp/blmbu-cache.db" });
const { server } = await createTerminalServer(config);

export default server;
