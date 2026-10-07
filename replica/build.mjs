import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPatches } from "./apply-patches.mjs";

const config = fileURLToPath(new URL("./vite.config.mjs", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
await applyPatches();
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
  "--prefix", "web", "run", "build", "--", "--config", config,
], { cwd: root, stdio: "inherit", shell: false });
if (result.error) throw result.error;
if (result.status === 0) {
  // The replica gets its own EdgeOne domain after deployment.
  writeFileSync(new URL("../web/dist/robots.txt", import.meta.url), "User-agent: *\nAllow: /\n");
  rmSync(new URL("../web/dist/sitemap.xml", import.meta.url), { force: true });
}
process.exit(result.status ?? 1);
