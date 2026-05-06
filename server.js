const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3210;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const cookieJar = {};

function getCookies(key) {
  return cookieJar[key] || [];
}

function storeCookies(key, headers) {
  const sc = headers["set-cookie"];
  if (!sc) return;
  if (!cookieJar[key]) cookieJar[key] = [];
  const raw = Array.isArray(sc) ? sc : [sc];
  for (const c of raw) {
    const name = c.split("=")[0].trim();
    cookieJar[key] = cookieJar[key].filter((e) => !e.startsWith(name + "="));
    cookieJar[key].push(c.split(";")[0]);
  }
}

function ncProxy(req, res, targetUrl, ncKey) {
  const url = new URL(targetUrl);
  const storedCookies = getCookies(ncKey);

  const outHeaders = { ...req.headers, host: url.hostname };
  delete outHeaders["accept-encoding"];
  if (storedCookies.length > 0) {
    outHeaders.cookie = storedCookies.join("; ");
  }

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: req.method,
    headers: outHeaders,
    timeout: 300000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    storeCookies(ncKey, proxyRes.headers);

    const respHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
      "access-control-expose-headers": "*",
    };
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (
        k.toLowerCase() !== "set-cookie" &&
        k.toLowerCase() !== "access-control-allow-origin"
      ) {
        respHeaders[k] = v;
      }
    }

    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("timeout", () => {
    console.error("NC Proxy timeout:", req.method, targetUrl);
    proxyReq.destroy(new Error("Proxy timeout (300s)"));
  });

  proxyReq.on("error", (e) => {
    console.error("NC Proxy error:", e.message, "target:", targetUrl);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

function nbcProxy(req, res, targetUrl) {
  const url = new URL(targetUrl);
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.hostname },
    timeout: 300000,
  };
  delete options.headers["accept-encoding"];

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    });
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("timeout", () => {
    console.error("NBC Proxy timeout:", req.method, targetUrl);
    proxyReq.destroy(new Error("Proxy timeout (300s)"));
  });

  proxyReq.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    });
    res.end();
    return;
  }

  if (req.url.startsWith("/proxy/nc-init/")) {
    const withoutPrefix = req.url.replace("/proxy/nc-init/", "");
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      res.writeHead(400);
      res.end("Missing target URL");
      return;
    }
    const targetBase = decodeURIComponent(
      withoutPrefix.substring(0, firstSlash),
    );
    const targetPath = withoutPrefix.substring(firstSlash);
    const targetUrl = targetBase + targetPath;
    const ncKey = targetBase;

    const storedCookies = getCookies(ncKey);
    const outHeaders = { ...req.headers, host: new URL(targetUrl).hostname };
    delete outHeaders["accept-encoding"];
    if (storedCookies.length > 0) {
      outHeaders.cookie = storedCookies.join("; ");
    }

    const url = new URL(targetUrl);
    const proxyReq = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: outHeaders,
      },
      (proxyRes) => {
        storeCookies(ncKey, proxyRes.headers);
        let body = "";
        proxyRes.on("data", (c) => (body += c));
        proxyRes.on("end", () => {
          res.writeHead(proxyRes.statusCode, {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "*",
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({
              ok: proxyRes.statusCode < 400,
              cookies: getCookies(ncKey).length,
              status: proxyRes.statusCode,
            }),
          );
        });
      },
    );
    proxyReq.on("error", (e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    proxyReq.end();
    return;
  }

  if (req.url.startsWith("/proxy/nc/")) {
    const withoutPrefix = req.url.replace("/proxy/nc/", "");
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      res.writeHead(400);
      res.end("Missing target URL");
      return;
    }
    const targetBase = decodeURIComponent(
      withoutPrefix.substring(0, firstSlash),
    );
    const targetPath = withoutPrefix.substring(firstSlash);
    ncProxy(req, res, targetBase + targetPath, targetBase);
    return;
  }

  if (req.url.startsWith("/proxy/nbc-custom/")) {
    const encoded = req.url.replace("/proxy/nbc-custom/", "");
    const firstSlash = encoded.indexOf("/");
    if (firstSlash === -1) {
      res.writeHead(400);
      res.end("Missing target URL");
      return;
    }
    const targetBase = decodeURIComponent(encoded.substring(0, firstSlash));
    const targetPath = encoded.substring(firstSlash);
    nbcProxy(req, res, targetBase + targetPath);
    return;
  }

  if (req.url.startsWith("/proxy/nbc-ssr/")) {
    const targetPath = req.url.replace("/proxy/nbc-ssr/", "/");
    const targetUrl = "https://niedersachsen.cloud" + targetPath;
    const url = new URL(targetUrl);

    const authHeader = req.headers["authorization"] || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "JWT required" }));
      return;
    }

    const outHeaders = {
      host: url.hostname,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-encoding": "identity",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      cookie: "jwt=" + jwt + "; isLoggedIn=true",
    };

    const followRedirect = req.headers["x-follow-redirect"] === "true";

    function doRequest(reqUrl, depth) {
      const u = new URL(reqUrl);
      outHeaders.host = u.hostname;
      const proxyReq = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: "GET",
          headers: outHeaders,
        },
        (proxyRes) => {
          if (
            followRedirect &&
            [301, 302, 303, 307, 308].includes(proxyRes.statusCode) &&
            proxyRes.headers.location &&
            depth < 5
          ) {
            let nextUrl = proxyRes.headers.location;
            if (nextUrl.startsWith("/")) {
              nextUrl = u.origin + nextUrl;
            }
            proxyRes.resume();
            doRequest(nextUrl, depth + 1);
            return;
          }

          const respHeaders = {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "*",
            "access-control-expose-headers": "x-redirect-url, location",
          };
          if (
            [301, 302, 303, 307, 308].includes(proxyRes.statusCode) &&
            proxyRes.headers.location
          ) {
            respHeaders["x-redirect-url"] = proxyRes.headers.location;
            respHeaders["location"] = proxyRes.headers.location;
          }
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (
              k.toLowerCase() !== "set-cookie" &&
              k.toLowerCase() !== "access-control-allow-origin" &&
              k.toLowerCase() !== "location"
            ) {
              respHeaders[k] = v;
            }
          }
          res.writeHead(proxyRes.statusCode, respHeaders);
          proxyRes.pipe(res, { end: true });
        },
      );
      proxyReq.on("error", (e) => {
        console.error("SSR Proxy error:", e.message, "target:", reqUrl);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      proxyReq.end();
    }

    doRequest(targetUrl, 0);
    return;
  }

  if (req.url.startsWith("/proxy/s3/")) {
    const targetUrl = decodeURIComponent(
      req.url.replace("/proxy/s3/", "https://"),
    );
    const url = new URL(targetUrl);
    const proxyReq = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: { host: url.hostname },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
          "content-type":
            proxyRes.headers["content-type"] || "application/octet-stream",
          "content-length": proxyRes.headers["content-length"] || "",
        });
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.on("error", (e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    proxyReq.end();
    return;
  }

  if (req.url.startsWith("/proxy/nbc/")) {
    const targetPath = req.url.replace("/proxy/nbc/", "/");
    nbcProxy(req, res, "https://niedersachsen.cloud" + targetPath);
    return;
  }

  let filePath = req.url.split("?")[0];
  if (filePath === "/") filePath = "/index.html";
  const fullPath = path.join(__dirname, "public", filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { "content-type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Migration tool running on http://127.0.0.1:" + PORT);
});
