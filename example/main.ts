import process from "node:process";
import { createServer } from "../src/server.ts";

const server = await createServer({
	port: Number(process.env.PORT) || 8000,
	staticDir: process.env.STATIC_DIR || "./static",
	configDir: process.env.CONFIG_DIR || "./config",
});

await server.start();
