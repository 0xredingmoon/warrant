import { createRelayerApp } from "./app";
import { loadConfigFromEnv } from "./config";

const cfg = loadConfigFromEnv();
const { app, relayerAddress } = createRelayerApp(cfg);
// Render (and most hosts) forward traffic to 0.0.0.0:$PORT; a port-only listen can bind IPv6-only.
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8787);
app.listen(port, host, () => {
  console.log(`warrant relayer listening on ${host}:${port}`);
  console.log(`  chain ${cfg.chainId}  rpc ${cfg.rpcUrl}`);
  console.log(`  relayer ${relayerAddress}  factory ${cfg.factory}`);
});
