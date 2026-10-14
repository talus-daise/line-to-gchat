import { defaultDeps, type Deps } from "./deps";
import { parseTargets, processEvents } from "./forward";
import { LineClient, verifyLineSignature } from "./line";
import { serveMedia } from "./media";
import type { Env, LineWebhookBody } from "./types";

const MAX_WEBHOOK_BYTES = 1_000_000;

const REQUIRED_FOR_WEBHOOK = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "GOOGLE_CHAT_WEBHOOK_URL",
  "MEDIA_SIGNING_SECRET",
] as const;

function missingConfig(env: Env, keys: readonly (keyof Env)[]): string[] {
  return keys.filter((k) => !env[k]);
}

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: Deps,
): Promise<Response> {
  const missing = missingConfig(env, REQUIRED_FOR_WEBHOOK);
  if (missing.length > 0) {
    console.error(`[config] missing bindings/secrets: ${missing.join(", ")}`);
    return new Response("Server misconfigured", { status: 500 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_WEBHOOK_BYTES) return new Response("Payload Too Large", { status: 413 });

  // 署名検証は「生のボディ」に対して行う (JSON.parse → stringify し直さない)
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return new Response("Payload Too Large", { status: 413 });

  const ok = await verifyLineSignature(
    env.LINE_CHANNEL_SECRET,
    rawBody,
    request.headers.get("x-line-signature"),
  );
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as LineWebhookBody;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const events = Array.isArray(payload.events) ? payload.events : [];

  // LINEには素早く 200 を返し、転送処理(表示名取得・Chat送信)はレスポンス後に続ける
  if (events.length > 0) {
    const baseUrl = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
    ctx.waitUntil(
      processEvents(events, {
        env,
        deps,
        baseUrl,
        line: new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, deps),
        targets: parseTargets(env.TARGET_LINE_GROUP_IDS),
      }),
    );
  }
  return new Response("OK");
}

export function createWorker(deps: Deps = defaultDeps): ExportedHandler<Env> {
  return {
    async fetch(request, env, ctx) {
      const { pathname } = new URL(request.url);

      if (pathname === "/webhook" && request.method === "POST") {
        return handleWebhook(request, env, ctx, deps);
      }

      if (pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
        const missing = missingConfig(env, ["LINE_CHANNEL_ACCESS_TOKEN", "MEDIA_SIGNING_SECRET"]);
        if (missing.length > 0) {
          console.error(`[config] missing bindings/secrets: ${missing.join(", ")}`);
          return new Response("Server misconfigured", { status: 500 });
        }
        return serveMedia(request, env, deps);
      }

      if (pathname === "/" && request.method === "GET") {
        return new Response("line-to-gchat is running");
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}

export default createWorker();
