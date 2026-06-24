#!/usr/bin/env node
'use strict'

// =============================================================================
// WORKAROUND(mcp-auth-proxy#178) — stdio tools/list schema normalizer
//
// WHY THIS EXISTS
//   mcp-auth-proxy (>= 2.10.2) relays tools/list from the stdio MCP child out
//   over its HTTP /mcp endpoint by round-tripping each tool through its MCP
//   library. That round-trip renames a tool schema's JSON Schema `definitions`
//   keyword to `$defs` but leaves `$ref` targets pointing at `#/definitions/...`,
//   producing a dangling $ref. MCP clients that compile tool schemas (e.g. the
//   official SDK's high-level listTools(), via ajv) then throw, which can break
//   tool discovery. Upstream bug: https://github.com/sigbit/mcp-auth-proxy/issues/178
//
// WHAT IT DOES
//   The proxy spawns this shim; this shim spawns the real MCP bin. It forwards
//   ALL stdio byte-for-byte EXCEPT tools/list result messages, whose tool
//   schemas it pre-migrates to a self-consistent draft-2020-12 form: rename the
//   root `definitions` bucket to `$defs` and rewrite every `$ref`
//   "#/definitions/..." -> "#/$defs/...". The proxy's half-rename then has
//   nothing left to break, so clients receive a resolvable schema. The rewrite
//   is semantics-preserving ($ref resolves by JSON Pointer regardless of bucket
//   name) and a no-op for MCPs whose schemas use no internal $ref or already use
//   `$defs`. It survives an eventual upstream fix too (output is already valid).
//
//   Scope note: only the ROOT `definitions` bucket is renamed (so a property
//   literally named "definitions" is never touched); $ref rewriting is applied
//   at any depth ($ref keys are unambiguous). Nested non-root `definitions`
//   buckets are out of scope (not observed in practice).
//
//   Transport assumption: MCP stdio is newline-delimited JSON-RPC (one message
//   per line, no embedded newlines), per the MCP spec.
//
// HOW TO REMOVE (once #178 is fixed upstream AND the Dockerfile proxy FROM pin
// has been bumped to a release containing the fix) — `grep -rn 'mcp-auth-proxy#178'`
// finds every touch point:
//   1. delete this file (mcp-schema-shim.cjs)
//   2. revert entrypoint.sh to exec the MCP bin directly (drop `node <shim>`)
//   3. remove the `COPY mcp-schema-shim.cjs` line from the Dockerfile
//   The e2e test stays on high-level listTools(); it passes once the proxy is
//   fixed, with or without this shim.
// =============================================================================

const { spawn } = require('node:child_process')

const [binPath, ...binArgs] = process.argv.slice(2)
if (!binPath) {
  process.stderr.write('mcp-schema-shim: missing MCP bin path argument\n')
  process.exit(2)
}

// stderr is inherited so the child's logs reach the proxy unchanged.
const child = spawn(binPath, binArgs, { stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', (err) => {
  process.stderr.write(`mcp-schema-shim: failed to start MCP bin: ${err.message}\n`)
  process.exit(127)
})

// proxy -> child stdin, verbatim (pipe ends child stdin on EOF).
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {}) // swallow EPIPE if the child has already exited
process.stdout.on('error', () => {}) // swallow EPIPE if the proxy closed our stdout

// child stdout -> (normalize tools/list) -> proxy, line by line.
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    process.stdout.write(transformLine(line) + '\n')
  }
})

// Forward termination signals so the child shuts down cleanly; the child's
// close event (below) then ends this process.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig) } catch (_) {} })
}

// Exit with the child's status once it has fully closed, flushing stdout first.
child.on('close', (code, signal) => {
  if (buf.length) { process.stdout.write(transformLine(buf)); buf = '' } // trailing partial (no newline)
  const exitCode = signal ? 1 : (code == null ? 0 : code)
  if (process.stdout.writableLength === 0) {
    process.exit(exitCode)
  } else {
    process.stdout.once('drain', () => process.exit(exitCode))
    setTimeout(() => process.exit(exitCode), 2000).unref() // safety net if drain never fires
  }
})

// --- transform ---------------------------------------------------------------

// Only tools/list *results* carry tool schemas; everything else is forwarded
// unchanged. On any parse failure or non-target message, returns the ORIGINAL
// line untouched (byte-preserving).
function transformLine(line) {
  if (line.trim() === '') return line
  let msg
  try {
    msg = JSON.parse(line)
  } catch (_) {
    return line
  }
  if (!msg || typeof msg !== 'object' || !msg.result || !Array.isArray(msg.result.tools)) {
    return line
  }
  let changed = false
  for (const tool of msg.result.tools) {
    if (!tool || typeof tool !== 'object') continue
    if (normalizeSchema(tool.inputSchema)) changed = true
    if (normalizeSchema(tool.outputSchema)) changed = true
  }
  return changed ? JSON.stringify(msg) : line
}

// Migrate one tool schema to consistent `$defs`/`#/$defs/`. Returns true if
// anything changed.
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  let changed = false
  if (Object.prototype.hasOwnProperty.call(schema, 'definitions')) {
    if (schema.$defs == null) {
      schema.$defs = schema.definitions
    } else if (typeof schema.$defs === 'object') {
      for (const k of Object.keys(schema.definitions)) {
        if (!(k in schema.$defs)) schema.$defs[k] = schema.definitions[k]
      }
    }
    delete schema.definitions
    changed = true
  }
  if (rewriteRefs(schema)) changed = true
  return changed
}

const REF_PREFIX = '#/definitions/'
function rewriteRefs(node) {
  let changed = false
  if (Array.isArray(node)) {
    for (const item of node) if (rewriteRefs(item)) changed = true
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const val = node[key]
      if (key === '$ref' && typeof val === 'string' && val.startsWith(REF_PREFIX)) {
        node[key] = '#/$defs/' + val.slice(REF_PREFIX.length)
        changed = true
      } else if (rewriteRefs(val)) {
        changed = true
      }
    }
  }
  return changed
}
