import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const isProduction = process.env.NODE_ENV === "production";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction,
  port: parseInt(process.env.PORT ?? "3000", 10),

  // PostgreSQL: prefer an explicit connection string (Render), else discrete parts.
  pg: process.env.PG_CONNECTION_STRING
    ? { connectionString: process.env.PG_CONNECTION_STRING }
    : {
        host: process.env.PG_HOST ?? "localhost",
        port: parseInt(process.env.PG_PORT ?? "5432", 10),
        database: requireEnv("PG_DATABASE"),
        user: requireEnv("PG_USER"),
        password: requireEnv("PG_PASSWORD"),
      },

  // Redis: prefer an explicit URL (Render), else discrete parts.
  redis: process.env.REDIS_URL
    ? { connectionUrl: process.env.REDIS_URL }
    : {
        host: process.env.REDIS_HOST ?? "localhost",
        port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      },

  // Development-only SSRF bypass list (comma-separated lowercase hostnames).
  devAllowedLocalHosts: (process.env.DEV_ALLOWED_LOCAL_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0),
};