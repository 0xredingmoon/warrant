import { createRelayerApp } from "./app";
import { loadConfigFromEnv } from "./config";

const cfg = loadConfigFromEnv();
const { app, relayerAddress } = createRelayerApp(cfg);
const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`warrant relayer listening on :${port}`);
  console.log(`  chain ${cfg.chainId}  rpc ${cfg.rpcUrl}`);
  console.log(`  relayer ${relayerAddress}  factory ${cfg.factory}`);
});
