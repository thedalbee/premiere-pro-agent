import { PluginBridge } from "./plugin-bridge.js";
import { createControlServer } from "./control-server.js";

const CONTROL_PORT = 7201;

const bridge = new PluginBridge();
bridge.start();

const control = createControlServer(bridge);
control.listen(CONTROL_PORT, "127.0.0.1");

function shutdown(): void {
  bridge.stop();
  control.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
