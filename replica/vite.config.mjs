import { readFileSync } from "node:fs";
import { mergeConfig } from "../web/node_modules/vite/dist/node/index.js";
import upstreamConfig from "../web/vite.config.ts";

const { name } = JSON.parse(readFileSync(new URL("./site.json", import.meta.url), "utf8"));
if (typeof name !== "string" || !name.trim() || /["'`\\\r\n<>]/u.test(name)) {
  throw new Error("站名不能为空，也不能包含引号、反斜线或换行。");
}
const brand = (source) => source
  .replaceAll("Real API Pricing", name)
  .replaceAll("真实 API 定价", name)
  .replaceAll(" · realapipricing.com", "");

export default mergeConfig(upstreamConfig, {
  plugins: [{
    name: "subscription-replica-brand",
    enforce: "pre",
    transform(source, id) {
      if (!/[/\\]web[/\\]src[/\\].*\.[cm]?[jt]sx?(?:\?|$)/u.test(id)) return;
      const result = brand(source);
      if (result !== source) return { code: result, map: null };
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        // The user's EdgeOne domain is assigned after importing the repository.
        // Omit the upstream canonical URL rather than claiming its origin.
        return brand(html)
          .replace(/\s*<link\s+rel="canonical"[^>]*>/gu, "")
          .replace(/\s*<meta\s+property="og:url"[^>]*>/gu, "");
      },
    },
  }],
});
