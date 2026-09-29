import { loadConfig } from "./config.js";
import { createTerminalServer } from "./server.js";

const config = loadConfig();
const { server, summary } = await createTerminalServer(config);
server.listen(config.port, () => {
  console.log(`BLMBU server on :${config.port} (${summary})`);
});
