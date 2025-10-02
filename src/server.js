import http from "node:http";

const PORT = parseInt(process.env.PORT || "80", 10);
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || "2500", 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "30000", 10);

const HOSTS = [
  "minecraft.net",
  "sessionserver.mojang.com",
  "login.microsoftonline.com",
  "textures.minecraft.net",
  "resources.download.minecraft.net",
  "libraries.minecraft.net",
  "api.minecraftservices.com",
];

const CUSTOM_CHECKS = {
  "sessionserver.mojang.com": {
    type: "jsonAny",
    url: "https://sessionserver.mojang.com/session/minecraft/profile/853c80ef3c3749fdaa49938b674adae6",
  },
  "api.minecraftservices.com": {
    type: "jsonAny",
    url: "https://api.minecraftservices.com/minecraft/profile/lookup/name/jeb_",
  },
  "libraries.minecraft.net": {
    type: "urlOk",
    url: "https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.pom",
  },
  "textures.minecraft.net": {
    type: "urlOk",
    url: "https://textures.minecraft.net/texture/7fd9ba42a7c81eeea22f1524271ae85a8e045ce0af5a6ae16c6406ae917e68b5",
  },
  "resources.download.minecraft.net": {
    type: "urlOk",
    url: "https://resources.download.minecraft.net/aa/aa1d3aace1c481ac32d5827fba287294b6bc99fb",
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

async function probeJsonAny(url) {
  const { controller, cancel } = abortSignalWithTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (!isOkStatus(res.status)) return "red";

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json") || ct.includes("+json")) {
      return "green";
    }
    try {
      await res.json();
      return "green";
    } catch {
      return "red";
    }
  } catch {
    return "red";
  } finally {
    cancel();
  }
}

async function probeUrlOk(url) {
  const { controller, cancel } = abortSignalWithTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    return isOkStatus(res.status) ? "green" : "red";
  } catch {
    return "red";
  } finally {
    cancel();
  }
}

async function probeHost(host) {
  const custom = CUSTOM_CHECKS[host];
  if (custom) {
    switch (custom.type) {
      case "jsonAny":
        return probeJsonAny(custom.url);
      case "urlOk":
        return probeUrlOk(custom.url);
      default:
        return probeHostBasic(host);
    }
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

  try {
    if (req.method === "GET" && req.url && req.url.startsWith("/status")) {
      const data = await getStatusData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK. Try GET /status");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal_error", message: e?.message || "unknown" }));
  }
});

server.listen(PORT, () => {
  console.log(`Status server running!`);
});
