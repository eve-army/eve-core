/**
 * Removes @next/swc-* native packages (except wasm). Prevents Next from loading
 * the wrong Linux ABI (e.g. musl .node on glibc) or a broken native binary.
 * Pair with NEXT_TEST_WASM=1 and @next/swc-wasm-nodejs in package.json.
 */
const fs = require("fs");
const path = require("path");

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function stripAtNext(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith("swc-") && !name.includes("wasm")) {
      rm(path.join(dir, name));
    }
  }
}

const root = path.join(__dirname, "..");
stripAtNext(path.join(root, "node_modules", "@next"));
stripAtNext(path.join(root, "node_modules", "next", "node_modules", "@next"));
