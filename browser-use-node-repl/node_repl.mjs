#!/usr/bin/env node
import { builtinModules, createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import util from "node:util";
import vm from "node:vm";
import { Buffer } from "node:buffer";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const SERVER_INFO = {
  name: "node_repl",
  version: "0.1.0-linux",
};
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const CELL_BASE_URL = pathToFileURL(path.join(process.cwd(), "node_repl_cell.mjs")).href;
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

let inputBuffer = Buffer.alloc(0);
let framingMode = "content-length";
let nextCellId = 0;
let nextRequestId = 0;
let requestMeta = {};
let responseMeta = {};
let emittedContent = [];
let cellQueue = Promise.resolve();
const pendingClientRequests = new Map();
const moduleCache = new Map();
const requireFromCwd = createRequire(pathToFileURL(path.join(process.cwd(), "node_repl.cjs")));

let context = createContext();

function createContext() {
  const sandbox = {
    AbortController,
    AbortSignal,
    ArrayBuffer,
    Blob,
    Buffer,
    clearImmediate,
    clearInterval,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    fetch: (...args) => fetch(...args),
    FormData,
    Headers,
    MessageChannel,
    MessageEvent,
    MessagePort,
    performance,
    process,
    queueMicrotask,
    ReadableStream,
    Request,
    require: requireFromCwd,
    Response,
    setImmediate,
    setInterval,
    setTimeout,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    WebSocket: globalThis.WebSocket,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.nodeRepl = createNodeReplBridge();
  return vm.createContext(sandbox, {
    name: "codex-browser-use-node-repl",
  });
}

function createNodeReplBridge() {
  return {
    get requestMeta() {
      return requestMeta;
    },
    fetch: (...args) => fetch(...args),
    nativePipe: {
      createConnection(pipePath) {
        return net.createConnection(pipePath);
      },
    },
    setResponseMeta(meta) {
      if (isRecord(meta)) {
        responseMeta = { ...responseMeta, ...meta };
      }
    },
    async emitImage(dataUrl) {
      const parsed = parseDataUrl(dataUrl);
      if (parsed == null) {
        emittedContent.push({ type: "text", text: String(dataUrl) });
        return;
      }
      emittedContent.push({
        type: "image",
        mimeType: parsed.mimeType,
        data: parsed.data,
      });
    },
    createElicitation(params) {
      return sendClientRequest("elicitation/create", params);
    },
  };
}

function resetRuntime() {
  moduleCache.clear();
  context = createContext();
}

function toolList() {
  return [
    {
      name: "js",
      description:
        "Execute JavaScript in a persistent Node.js context for Codex Browser Use.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code to execute.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
    {
      name: "js_reset",
      description: "Reset the persistent JavaScript context.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
}

async function callTool(params) {
  const name = params?.name;
  requestMeta = isRecord(params?._meta) ? params._meta : {};
  responseMeta = {};
  emittedContent = [];

  if (name === "js_reset") {
    resetRuntime();
    return toolResult("JavaScript context reset.");
  }

  if (name !== "js") {
    throw new Error(`Unknown tool: ${String(name)}`);
  }

  const code = extractCode(params?.arguments);
  return cellQueue = cellQueue
    .catch(() => undefined)
    .then(() => runJavaScript(code));
}

async function runJavaScript(code) {
  const output = [];
  const previousConsole = context.console;
  context.console = makeConsoleCapture(output);

  try {
    const script = new vm.Script(`(async () => {\n${String(code)}\n})()`, {
      filename: `node_repl_cell_${++nextCellId}.mjs`,
      importModuleDynamically: dynamicImport,
    });
    const value = await script.runInContext(context);
    if (value !== undefined) {
      output.push(util.inspect(value, {
        colors: false,
        depth: 8,
        maxArrayLength: 200,
        breakLength: 100,
      }));
    }
    return toolResult(output.join("\n"));
  } catch (error) {
    return toolResult(errorStack(error), { isError: true });
  } finally {
    context.console = previousConsole;
  }
}

function makeConsoleCapture(output) {
  const capture = (...args) => {
    output.push(util.format(...args));
  };
  return {
    assert(condition, ...args) {
      if (!condition) {
        capture("Assertion failed:", ...args);
      }
    },
    clear() {},
    count(label = "default") {
      capture(`${label}: 1`);
    },
    countReset() {},
    debug: capture,
    dir(value) {
      capture(util.inspect(value, { colors: false, depth: 6 }));
    },
    error: capture,
    group: capture,
    groupCollapsed: capture,
    groupEnd() {},
    info: capture,
    log: capture,
    table: capture,
    time() {},
    timeEnd(label = "default") {
      capture(`${label}: 0ms`);
    },
    trace: capture,
    warn: capture,
  };
}

async function dynamicImport(specifier, referencingScriptOrModule) {
  const referrer =
    typeof referencingScriptOrModule?.identifier === "string"
      ? referencingScriptOrModule.identifier
      : CELL_BASE_URL;
  const module = await loadModule(specifier, referrer);
  return module;
}

async function loadModule(specifier, referrer) {
  const resolved = resolveModuleSpecifier(specifier, referrer);
  let record = moduleCache.get(resolved);
  if (record == null) {
    record = {
      module: await createModule(resolved),
      linking: null,
      evaluating: null,
    };
    moduleCache.set(resolved, record);
  }

  if (record.module.status === "unlinked") {
    record.linking ??= record.module.link((childSpecifier, referencingModule) =>
      loadModule(childSpecifier, referencingModule.identifier)
    );
    await record.linking;
  }

  if (record.module.status === "linked") {
    record.evaluating ??= record.module.evaluate();
    await record.evaluating;
  }

  return record.module;
}

async function createModule(resolved) {
  if (BUILTINS.has(resolved)) {
    const imported = await import(resolved.startsWith("node:") ? resolved : `node:${resolved}`);
    const names = Object.keys(imported);
    return new vm.SyntheticModule(
      names,
      function initializeBuiltinModule() {
        for (const name of names) {
          this.setExport(name, imported[name]);
        }
      },
      {
        context,
        identifier: resolved,
      },
    );
  }

  const url = new URL(resolved);
  if (url.protocol !== "file:") {
    throw new Error(`Unsupported import protocol: ${url.protocol}`);
  }

  const source = await readFile(fileURLToPath(url), "utf8");
  return new vm.SourceTextModule(source, {
    context,
    identifier: url.href,
    initializeImportMeta(meta, module) {
      meta.url = module.identifier;
      meta.__codexNativePipe = context.nodeRepl.nativePipe;
    },
    importModuleDynamically: dynamicImport,
  });
}

function resolveModuleSpecifier(specifier, referrer) {
  if (BUILTINS.has(specifier)) {
    return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  }
  if (specifier.startsWith("file:")) {
    return new URL(specifier).href;
  }
  if (path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return new URL(specifier, referrer).href;
}

function parseDataUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (match == null) {
    return null;
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function extractCode(value) {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    for (const key of ["code", "javascript", "script", "input"]) {
      if (typeof value[key] === "string") {
        return value[key];
      }
    }
  }
  return "";
}

function toolResult(text, options = {}) {
  const content = [];
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  content.push(...emittedContent);
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return {
    content,
    isError: options.isError === true,
    ...(Object.keys(responseMeta).length > 0 ? { _meta: responseMeta } : {}),
  };
}

async function handleMessage(message) {
  if (message == null || typeof message !== "object") {
    return;
  }

  if ("id" in message && !("method" in message)) {
    handleClientResponse(message);
    return;
  }

  const { id, method, params } = message;
  try {
    switch (method) {
      case "initialize":
        return respond(id, {
          protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
        return;
      case "ping":
        return respond(id, {});
      case "tools/list":
        return respond(id, { tools: toolList() });
      case "tools/call":
        return respond(id, await callTool(params ?? {}));
      case "resources/list":
        return respond(id, { resources: [] });
      case "resources/templates/list":
        return respond(id, { resourceTemplates: [] });
      case "prompts/list":
        return respond(id, { prompts: [] });
      default:
        if (id != null) {
          return respondError(id, -32601, `Method not found: ${String(method)}`);
        }
    }
  } catch (error) {
    if (id != null) {
      return respondError(id, -32000, errorStack(error));
    }
  }
}

function respond(id, result) {
  if (id == null) {
    return;
  }
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function respondError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function sendClientRequest(method, params) {
  const id = `node_repl_${++nextRequestId}`;
  sendMessage({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
  });
}

function handleClientResponse(message) {
  const pending = pendingClientRequests.get(message.id);
  if (pending == null) {
    return;
  }
  pendingClientRequests.delete(message.id);
  if (message.error != null) {
    pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
  } else {
    pending.resolve(message.result);
  }
}

function sendMessage(message) {
  const payload = JSON.stringify(message);
  if (framingMode === "newline") {
    process.stdout.write(`${payload}\n`);
    return;
  }
  const body = Buffer.from(payload, "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handleInput(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length > 0) {
    const parsed = parseNextMessage(inputBuffer);
    if (parsed == null) {
      return;
    }
    inputBuffer = parsed.remaining;
    handleMessage(parsed.message).catch((error) => {
      process.stderr.write(`${errorStack(error)}\n`);
    });
  }
}

function parseNextMessage(buffer) {
  const leadingWhitespace = /^[\r\n\t ]+/.exec(buffer.toString("utf8", 0, Math.min(buffer.length, 16)));
  if (leadingWhitespace != null) {
    buffer = buffer.subarray(Buffer.byteLength(leadingWhitespace[0]));
  }

  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd >= 0) {
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1];
    if (contentLength == null) {
      throw new Error("Missing Content-Length header");
    }
    const length = Number(contentLength);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return null;
    }
    framingMode = "content-length";
    return {
      message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")),
      remaining: buffer.subarray(bodyEnd),
    };
  }

  if (buffer.subarray(0, 15).toString("utf8").toLowerCase().startsWith("content-length")) {
    return null;
  }

  const newline = buffer.indexOf("\n");
  if (newline < 0) {
    return null;
  }
  const line = buffer.subarray(0, newline).toString("utf8").trim();
  framingMode = "newline";
  return {
    message: JSON.parse(line),
    remaining: buffer.subarray(newline + 1),
  };
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function errorStack(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

process.stdin.on("data", handleInput);
process.stdin.on("end", () => {
  process.exit(0);
});
