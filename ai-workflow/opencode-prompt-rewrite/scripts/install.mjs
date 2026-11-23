#!/usr/bin/env node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const repoRoot = path.resolve(import.meta.dirname, "..")
const targetDir = path.resolve(
  process.env.OPENCODE_SHARE_DIR || path.join(os.homedir(), ".local", "share", "opencode", "prompt-rewrite"),
)
const shimDir = path.resolve(
  process.env.OPENCODE_PLUGIN_DIR || path.join(os.homedir(), ".config", "opencode", "plugins", "prompt-rewrite"),
)

const SKIP_COPY = new Set([".git", ".DS_Store", "node_modules"])
const PRESERVE_IN_TARGET = new Set(["node_modules"])

function shouldPreserve(name) {
  return PRESERVE_IN_TARGET.has(name) || name === ".env" || name.startsWith(".env.")
}

function syncDirectory(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true })
  const srcNames = new Set()

  for (const entry of srcEntries) {
    if (SKIP_COPY.has(entry.name)) continue
    srcNames.add(entry.name)
    const srcPath = path.join(srcDir, entry.name)
    const dstPath = path.join(dstDir, entry.name)

    if (entry.isDirectory()) {
      syncDirectory(srcPath, dstPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath)
      const stat = fs.statSync(srcPath)
      fs.chmodSync(dstPath, stat.mode)
    }
  }

  for (const existing of fs.readdirSync(dstDir, { withFileTypes: true })) {
    if (shouldPreserve(existing.name) || SKIP_COPY.has(existing.name)) continue
    if (!srcNames.has(existing.name)) {
      fs.rmSync(path.join(dstDir, existing.name), { recursive: true, force: true })
    }
  }
}

function ensureShims() {
  fs.mkdirSync(shimDir, { recursive: true })
  let relBase = path.relative(shimDir, targetDir).split(path.sep).join("/")
  if (!relBase.startsWith(".")) relBase = `./${relBase}`

  const files = {
    "package.json": `${JSON.stringify(
      {
        name: "opencode-prompt-rewrite-local",
        private: true,
        type: "module",
        exports: {
          ".": "./index.js",
          "./tui": "./tui.tsx",
          "./rpc": "./rpc.js",
        },
      },
      null,
      2,
    )}\n`,
    "index.js": `// Local prompt rewrite V2: Grill Me, model advisor, live progress, and Rewrite Studio.\nexport { default } from "${relBase}/index.js"\n`,
    "rpc.js": `export { Rewrite } from "${relBase}/rpc.js"\n`,
    "tui.tsx": `export { default } from "${relBase}/tui.tsx"\n`,
  }

  const updated = []
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(shimDir, name)
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null
    if (current !== content) {
      fs.writeFileSync(filePath, content, "utf8")
      updated.push(name)
    }
  }
  return updated
}

if (fs.existsSync(targetDir) && fs.realpathSync(repoRoot) === fs.realpathSync(targetDir)) {
  console.error(`Refusing to install: source and target resolve to the same directory (${targetDir}).`)
  process.exit(1)
}

syncDirectory(repoRoot, targetDir)
const updatedShims = ensureShims()

const testDir = path.join(targetDir, "test")
const testFiles = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name))

execFileSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" })

console.log(`\nInstalled prompt-rewrite plugin to: ${targetDir}`)
console.log(
  `OpenCode plugin shims in ${shimDir}: ${updatedShims.length ? `updated (${updatedShims.join(", ")})` : "already up to date"}`,
)
console.log("Restart OpenCode if it is currently running to load the updated plugin.")
