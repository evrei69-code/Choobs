const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..", "app");
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendNotFound(response) {
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  let requestPath;
  try {
    requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
  } catch (error) {
    sendNotFound(response);
    return;
  }

  if (requestPath.charAt(requestPath.length - 1) === "/") requestPath += "index.html";
  const filePath = path.resolve(root, `.${requestPath}`);
  if (filePath !== root && filePath.indexOf(`${root}${path.sep}`) !== 0) {
    sendNotFound(response);
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendNotFound(response);
      return;
    }

    const headers = {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stats.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache"
    };
    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!response.headersSent) sendNotFound(response);
      else response.destroy();
    });
    stream.pipe(response);
  });
});

server.listen(port, host, () => {
  console.log(`Choobs preview listening on http://localhost:${port}`);
});

server.on("error", (error) => {
  console.error(`Preview server failed: ${error.message}`);
  process.exitCode = 1;
});
