#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { IcsCalendarSource } from "./source.js";

const config = loadConfig();
const source = new IcsCalendarSource(config.calendars, config.cacheTtlMs, config.allowedHosts);
const server = createServer(source, config.defaultTimezone);

await server.connect(new StdioServerTransport());
