/**
 * AgentX cloud browser PoC — Cloudflare Worker + Durable Object relay.
 *
 * Architecture (no third-party tunnel service):
 *
 *   Client --HTTPS/WSS + CLIENT_TOKEN--> Worker --(DO binding)--> BrowserRelay DO
 *                                                              (singleton, named "browser-main")
 *   GitHub runner: Chromium --CDP--> relay.py --WSS + RELAY_SECRET--> same DO
 *
 * The Durable Object is a singleton, so the runner's uplink WebSocket and all
 * client requests meet in one place — no isolate problem, no tunnel provider,
 * no extra signup. The runner just opens an outbound WSS to /relay; the DO
 * swaps in a successor runner with zero client-visible downtime.
 *
 * No KV is used at all: the DO itself tracks whether a runner is connected.
 */

const DO_NAME = "browser-main";
const HTTP_TIMEOUT_MS = 15000;

export class BrowserRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.runner = null;          // WebSocket to the current runner uplink
    this.clients = new Map();    // connId -> client WebSocket (CDP sessions)
    this.pending = new Map();    // httpReqId -> {resolve, timer}
    this.seq = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---- Runner uplink: persistent WebSocket, authenticated by RELAY_SECRET ----
    if (path === "/relay") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("websocket required", { status: 400 });
      }
      if (url.searchParams.get("secret") !== this.env.RELAY_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      // A successor runner replaces the old uplink seamlessly.
      if (this.runner) { try { this.runner.close(1000, "replaced"); } catch (e) {} }
      // Drop any client sessions tied to the old runner; clients reconnect.
      for (const [, ws] of this.clients) { try { ws.close(1001, "runner replaced"); } catch (e) {} }
      this.clients.clear();
      this.runner = server;
      server.addEventListener("message", (ev) => this.onRunnerMessage(ev.data));
      const drop = () => { if (this.runner === server) this.runner = null; };
      server.addEventListener("close", drop);
      server.addEventListener("error", drop);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- Public health: reveals only whether a runner is connected ----
    if (path === "/health") {
      return Response.json({ ok: this.runner !== null, ts: Date.now() });
    }

    // ---- Client auth gate ----
    if (url.searchParams.get("token") !== this.env.CLIENT_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }
    if (!this.runner) {
      return Response.json({ error: "browser offline" }, { status: 503 });
    }

    // ---- Client CDP WebSocket: pipe through the runner ----
    if (req.headers.get("upgrade") === "websocket" && path.startsWith("/devtools/")) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const connId = "c" + (++this.seq) + "_" + Date.now().toString(36);
      this.clients.set(connId, server);
      try {
        this.runner.send(JSON.stringify({ type: "ws_open", id: connId, path: path }));
      } catch (e) {
        this.clients.delete(connId);
        return new Response("runner unavailable", { status: 502 });
      }
      server.addEventListener("message", (ev) => {
        if (this.runner) {
          try { this.runner.send(JSON.stringify({ type: "ws_msg", id: connId, data: ev.data })); } catch (e) {}
        }
      });
      const cleanup = () => {
        this.clients.delete(connId);
        if (this.runner) {
          try { this.runner.send(JSON.stringify({ type: "ws_close", id: connId })); } catch (e) {}
        }
      };
      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- Client CDP HTTP (e.g. /json/version, /json/list, PUT /json/new) ----
    if (path.startsWith("/json/")) {
      const reqId = "h" + (++this.seq);
      const body = (req.method === "GET" || req.method === "HEAD") ? null : await req.text();
      let result = null;
      try {
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(reqId);
            reject(new Error("timeout"));
          }, HTTP_TIMEOUT_MS);
          this.pending.set(reqId, { resolve, timer });
          try {
            this.runner.send(JSON.stringify({
              type: "http", id: reqId, method: req.method,
              path: path + url.search, body: body,
            }));
          } catch (e) {
            clearTimeout(timer);
            this.pending.delete(reqId);
            reject(e);
          }
        });
      } catch (e) { /* result stays null -> 504 */ }
      if (!result) return Response.json({ error: "browser timeout" }, { status: 504 });
      // Rewrite Chromium's ws://127.0.0.1:9222 URLs to our authenticated WSS endpoint.
      const text = (result.body || "").replaceAll("ws://127.0.0.1:9222", `wss://${url.host}`);
      return new Response(text, {
        status: result.status || 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  onRunnerMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.type === "http_res") {
      const p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
    } else if (msg.type === "ws_msg") {
      const client = this.clients.get(msg.id);
      if (client) { try { client.send(msg.data); } catch (e) {} }
    } else if (msg.type === "ws_closed") {
      const client = this.clients.get(msg.id);
      if (client) {
        try { client.close(1000, "target closed"); } catch (e) {}
        this.clients.delete(msg.id);
      }
    }
  }
}

export default {
  async fetch(req, env) {
    const id = env.RELAY.idFromName(DO_NAME);
    const stub = env.RELAY.get(id);
    return stub.fetch(req);
  },
};
