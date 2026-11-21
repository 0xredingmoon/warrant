/**
 * Official Vercel Express entry (https://vercel.com/docs/frameworks/backend/express).
 * Exporting the app from server.ts makes every path (/health, /v1/deposit, …) the same
 * function. The api/[[...path]].ts catch-all only received one-segment paths.
 *
 * The app is created on the first request so the build does not need secrets.
 * Warm instances reuse the same app and the ephemeral /tmp SQLite file.
 */
import type { Request, Response } from "express";
import { createRelayerApp, loadConfigFromEnv } from "./packages/relayer/dist/index.js";

type Handler = (req: Request, res: Response) => void;

let handler: Handler | undefined;

function getApp(): Handler {
  if (!handler) {
    const { app, relayerAddress } = createRelayerApp(loadConfigFromEnv());
    console.log(`warrant relayer ready (address ${relayerAddress})`);
    handler = app;
  }
  return handler;
}

export default function vercelRelayer(req: Request, res: Response) {
  return getApp()(req, res);
}
