/**
 * Single Vercel Function that serves every relayer route (`/health`, `/v1/pay`, …).
 * Official pattern: one shared function, not one file per endpoint
 * (https://vercel.com/docs/functions/runtimes/node-js,
 *  https://vercel.com/docs/frameworks/backend/express).
 *
 * The Express app is created on the first request so the build does not need
 * secrets. Warm instances reuse the same app and the ephemeral `/tmp` SQLite file.
 */
import type { Request, Response } from "express";
import express from "express";
import { createRelayerApp, loadConfigFromEnv } from "../packages/relayer/dist/index.js";

type Handler = (req: Request, res: Response) => void;

let handler: Handler | undefined;

function getHandler(): Handler {
  if (!handler) {
    const { app, relayerAddress } = createRelayerApp(loadConfigFromEnv());
    const gateway = express();
    // Rewrites send `/health` to this function as `/api/health`; keep both working.
    gateway.use("/api", app);
    gateway.use(app);
    console.log(`warrant relayer function ready (address ${relayerAddress})`);
    handler = gateway;
  }
  return handler;
}

export default function vercelRelayer(req: Request, res: Response) {
  return getHandler()(req, res);
}
