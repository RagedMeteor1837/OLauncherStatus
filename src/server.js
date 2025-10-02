import http from "node:http";
import fs from "node:fs";

const PORT = parseInt(process.env.PORT || "80", 10);
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || "2500", 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "30000", 10);

const EXPECTED_SESSION_JSON_PATH =
  process.env.EXPECTED_SESSION_JSON_PATH || "./sessionserver.json";

const EXPECTED_APIMS_JSON_PATH =
  process.env.EXPECTED_APIMS_JSON_PATH || "./apiminecraftservices.json";

let EXPECTED_SESSION_NAME = null;
try {
  const data = JSON.parse(fs.readFileSync(EXPECTED_SESSION_JSON_PATH, "utf8"));
  EXPECTED_SESSION_NAME = data?.name || null;
} catch (e) {
  console.warn(`Could not load ${EXPECTED_SESSION_JSON_PATH}:`, e.message);
}

function readJsonFile(path) {
  try {
    const raw = fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`Could not read/parse ${path}:`, e.message);
    return null;
  }
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

const HOSTS = [
  "minecraft.net",
  "session.minecraft.net",
  "api.mojang.com",
  "authserver.mojang.com",
  "sessionserver.mojang.com",
  "login.microsoftonline.com",
  "textures.minecraft.net",
  "pc.realms.minecraft.net",
  "resources.download.minecraft.net",
  "libraries.minecraft.net",
  "api.minecraftservices.com"
];

const CUSTOM_CHECKS = {
  "sessionserver.mojang.com": {
    type: "nameMatch",
    url: "https://sessionserver.mojang.com/session/minecraft/profile/853c80ef3c3749fdaa49938b674adae6",
    expectedName: EXPECTED_SESSION_NAME,
  },
  "api.minecraftservices.com": {
    type: "jsonExactMatch",
    url: "https://api.minecraftservices.com/minecraft/profile/",
    expectedJsonPath: EXPECTED_APIMS_JSON_PATH,
  },
};

function isOkStatus(code) {
  return code >= 200 && code < 400;
}

function abortSignalWithTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, cancel: () => clearTimeout(t) };
}

async function probeHostBasic(host) {
  const url = `https://${host}/`;
  const { controller, cancel } = abortSignalWithTimeout(PROBE_TIMEOUT_MS);

  const tryMethod = async (method) => {
    try {
      const res = await fetch(url, { method, redirect: "follow", signal: controller.signal });
      return isOkStatus(res.status);
    } catch {
      return false;
    }
  };

  let ok = await tryMethod("HEAD");
  if (!ok) ok = await tryMethod("GET");
  cancel();
  return ok ? "green" : "red";
}

async function probeNameMatch(url, expectedName) {
  if (!expectedName) return "red";
  const { controller, cancel } = abortSignalWithTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (!isOkStatus(res.status)) return "red";
    const live = await res.json();
    return live?.name === expectedName ? "green" : "red";
  } catch {
    return "red";
  } finally {
    cancel();
  }
}

async function probeJsonExactMatch(url, expectedJsonPath) {
  const expected = readJsonFile(expectedJsonPath);
  if (expected == null) return "red";

  const { controller, cancel } = abortSignalWithTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (!isOkStatus(res.status)) return "red";
    const live = await res.json();

    const liveCanon = canonicalStringify(live);
    const expCanon  = canonicalStringify(expected);
    return liveCanon === expCanon ? "green" : "red";
  } catch {
    return "red";
  } finally {
    cancel();
  }
}

async function probeHost(host) {
  const custom = CUSTOM_CHECKS[host];
  if (custom?.type === "nameMatch") {
    return probeNameMatch(custom.url, custom.expectedName);
  }
  if (custom?.type === "jsonExactMatch") {
    return probeJsonExactMatch(custom.url, custom.expectedJsonPath);
  }
  return probeHostBasic(host);
}

let cache = { data: null, expires: 0, inFlight: null };

async function getStatusData() {
  const now = Date.now();
  if (cache.data && cache.expires > now) return cache.data;
  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = (async () => {
    const results = await Promise.all(HOSTS.map((h) => probeHost(h)));
    const payload = HOSTS.map((h, i) => ({ [h]: results[i] }));
    cache = { data: payload, expires: now + CACHE_TTL_MS, inFlight: null };
    return payload;
  })();

  return cache.inFlight;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && req.url?.startsWith("/status")) {
    try {
      const data = await getStatusData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(data, null, 4));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "probe_failed" }));
    }
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK. Try GET /status");
});

server.listen(PORT, () => {
  console.log(`HTTP status server running on http://0.0.0.0:${PORT}`);
});
