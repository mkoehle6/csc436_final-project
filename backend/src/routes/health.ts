import { Router } from "express";

export const healthRouter = Router();

/** D4: CI/CD and uptime checks gate on this endpoint. */
healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});
