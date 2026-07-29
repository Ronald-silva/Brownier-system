import type { RequestHandler } from "express";
import { checkDatabaseConnection } from "./database.ts";

type DatabaseCheck = () => Promise<void>;

export function createHealthHandler(checkDatabase: DatabaseCheck = checkDatabaseConnection): RequestHandler {
  return async (_req, res) => {
    const timestamp = new Date().toISOString();
    try {
      await checkDatabase();
      res.status(200).json({ status: "ok", service: "brownier", database: "connected", timestamp });
    } catch {
      res.status(503).json({ status: "error", service: "brownier", database: "disconnected", timestamp });
    }
  };
}
