#!/usr/bin/env node

import { build } from "./build.js";

const command = process.argv[2];
if (command !== "build") printHelp();

const args = parseArgs();
if (Object.keys(args).includes("--help")) printHelp();

build();

function parseArgs() {
  return process.argv.slice(2).reduce(
    (acc, key, ind, self) => {
      if (key.startsWith("--")) {
        if (self[ind + 1] && self[ind + 1].startsWith("-")) {
          acc[key] = undefined;
        } else if (self[ind + 1]) {
          acc[key] = self[ind + 1];
        } else if (!self[ind + 1]) {
          acc[key] = undefined;
        }
      }
      return acc;
    },
    {} as Record<string, string | undefined>,
  );
}

function printHelp() {
  console.log("Unknown command");
  console.log("");
  console.log("Usage:");
  console.log("  npx open-next build");
  console.log("  npx open-next build --build-command 'npm run custom:build'");
  console.log("");

  process.exit(1);
}
