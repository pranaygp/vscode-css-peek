import { rm } from "node:fs/promises";

await Promise.all(
  [
    "client/out",
    "server/out",
    "tests/out",
    "dist",
    "client/tsconfig.tsbuildinfo",
    "server/tsconfig.tsbuildinfo",
    "tests/tsconfig.tsbuildinfo",
  ].map((path) => rm(path, { recursive: true, force: true })),
);
