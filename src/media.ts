import { base64UrlToBytes, bytesToBase64Url, hmacSha256, hmacVerify } from "./crypto";
import type { Deps } from "./deps";
import { LineApiError, LineClient } from "./line";
import type { Env } from "./types";

/**
 * 【ストレージ不要のメディア中継】
 *
 * Google Chat の Incoming Webhook はファイルを直接添付できません(カードの画像URL/リンクのみ)。
 * そこで、Chatには「このWorkerの署名付きURL」を渡し、URLが開かれた瞬間に
 * LINE Messaging API からバイナリを取得してそのままストリームで返します(R2などの保存先は不要)。
 *
 *   URL: {origin}/media/{kind}/{messageId}/{signature}/{filename}
 *   signature = base64url(HMAC-SHA256(MEDIA_SIGNING_SECRET, "media:{kind}:{messageId}:{filename}"))
 *
 * 署名が無いURLは配信しないため、messageId を推測されても LINE のコンテンツは取得できません。
 * なお LINE 側のコンテンツは一定期間で自動削除されるため、期限後はリンクが開けなくなります。
 */

export type MediaKind = "image" | "video" | "audio" | "file";

const DEFAULT_EXTENSION: Record<MediaKind, string> = {
  image: "jpg",
  video: "mp4",
  audio: "m4a",
  file: "bin",
};

const DEFAULT_CONTENT_TYPE: Record<MediaKind, string> = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/mp4",
  file: "application/octet-stream",
};

/** 自ドメインでインライン表示しても安全な種類だけを許可 (HTML/SVG などは常にダウンロード扱い) */
const INLINE_SAFE =
  /^(image\/(jpeg|png|gif|webp)|video\/mp4|audio\/(mp4|x-m4a|m4a|mpeg|aac)|application\/pdf)$/i;

export function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const star = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// ---- 署名付きURLの発行 ----

function signingInput(kind: string, messageId: string, filename: string): string {
  return `media:${kind}:${messageId}:${filename}`;
}

export interface MediaLinks {
  /** ブラウザ/カード画像用 (対応形式ならインライン表示) */
  url: string;
  /** 強制ダウンロード用 */
  downloadUrl: string;
  filename: string;
}

export async function buildMediaLinks(p: {
  secret: string;
  baseUrl: string;
  kind: MediaKind;
  messageId: string;
  /** file メッセージの元ファイル名 (他は自動生成) */
  filename?: string;
}): Promise<MediaLinks> {
  const fallback = `${p.kind}-${p.messageId}.${DEFAULT_EXTENSION[p.kind]}`;
  const filename = sanitizeFilename(p.filename ?? fallback, fallback);
  const sig = bytesToBase64Url(await hmacSha256(p.secret, signingInput(p.kind, p.messageId, filename)));
  const url = `${p.baseUrl}/media/${p.kind}/${p.messageId}/${sig}/${encodeURIComponent(filename)}`;
  return { url, downloadUrl: `${url}?dl=1`, filename };
}

// ---- 配信(LINEからのストリーム中継) ----

const ROUTE = /^\/media\/(image|video|audio|file)\/(\d{1,32})\/([A-Za-z0-9_-]{43})\/([^/]+)$/;

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=UTF-8" } });
}

function resolveContentType(kind: MediaKind, raw: string | null, filename: string): string {
  const type = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  if (kind === "file") {
    if ((!type || type === "application/octet-stream") && /\.pdf$/i.test(filename)) return "application/pdf";
    return type || DEFAULT_CONTENT_TYPE.file;
  }
  return type.startsWith(`${kind}/`) ? type : DEFAULT_CONTENT_TYPE[kind];
}

export async function serveMedia(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const m = ROUTE.exec(url.pathname);
  if (!m) return plain(404, "Not Found");
  const kind = m[1] as MediaKind;
  const messageId = m[2]!;
  const sig = m[3]!;

  let filename: string;
  try {
    filename = decodeURIComponent(m[4]!);
  } catch {
    return plain(404, "Not Found");
  }

  let valid = false;
  try {
    valid = await hmacVerify(env.MEDIA_SIGNING_SECRET, signingInput(kind, messageId, filename), base64UrlToBytes(sig));
  } catch {
    valid = false;
  }
  if (!valid) return plain(403, "Forbidden");

  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, deps);

  // 動画・音声はLINE側の変換が終わっていないことがあるので少し待つ
  if (kind === "video" || kind === "audio") {
    const status = await line.waitForTranscoding(messageId, 5, 2000);
    if (status === "failed") return plain(502, "LINE側で動画/音声の準備に失敗しました");
  }

  let upstream: Response;
  try {
    upstream = await line.getContent(messageId, request.headers.get("range"));
  } catch (err) {
    if (err instanceof LineApiError) {
      if (err.status === 404 || err.status === 410) {
        return plain(404, "LINE上のデータの保存期間が過ぎたため、取得できません");
      }
      if (err.status === 416) return plain(416, "Range Not Satisfiable");
      console.error(`[media] LINE content API returned ${err.status} for ${kind} ${messageId}`);
    } else {
      console.error(`[media] failed to reach LINE: ${(err as Error).message}`);
    }
    return plain(502, "LINEからデータを取得できませんでした");
  }

  const contentType = resolveContentType(kind, upstream.headers.get("content-type"), filename);
  const inline = INLINE_SAFE.test(contentType) && url.searchParams.get("dl") !== "1";

  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": contentDisposition(inline ? "inline" : "attachment", filename),
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  });
  // LINEがRangeに対応していればそのまま中継する (対応していなければ200で全体が返る)
  for (const name of ["content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  // 圧縮されている場合は content-length がずれるため付けない
  const length = upstream.headers.get("content-length");
  if (length && !upstream.headers.get("content-encoding")) headers.set("content-length", length);

  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
