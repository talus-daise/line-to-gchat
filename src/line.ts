import { base64ToBytes, hmacVerify } from "./crypto";
import type { Deps } from "./deps";
import type { LineProfile, LineSource } from "./types";

const LINE_API = "https://api.line.me";
const LINE_DATA_API = "https://api-data.line.me";

/**
 * x-line-signature の検証。
 * 署名は「リクエストボディ(生のバイト列)」に対する HMAC-SHA256(channel secret) の base64。
 */
export async function verifyLineSignature(
  channelSecret: string,
  rawBody: ArrayBuffer,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(signature);
  } catch {
    return false;
  }
  return hmacVerify(channelSecret, rawBody, sig);
}

export class LineApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LineApiError";
  }
}

// isolate 内で使い回す簡易キャッシュ (表示名・グループ名は頻繁に変わらないため)
const cache = new Map<string, { value: unknown; expires: number }>();

export function clearLineCache(): void {
  cache.clear();
}

async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T | null;
  const value = await load();
  // 失敗(null)は短めに保持して API を叩きすぎないようにする
  cache.set(key, { value, expires: Date.now() + (value === null ? 5 * 60_000 : ttlMs) });
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

export type TranscodingStatus = "succeeded" | "failed" | "timeout";

export class LineClient {
  constructor(
    private readonly accessToken: string,
    private readonly deps: Deps,
  ) {}

  private get headers(): HeadersInit {
    return { authorization: `Bearer ${this.accessToken}` };
  }

  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await this.deps.fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`[line] GET ${new URL(url).pathname} -> ${res.status}`);
        await res.body?.cancel();
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      console.warn(`[line] GET ${new URL(url).pathname} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** 送信者のプロフィール (表示名・アイコン)。取得できなければ null */
  getMemberProfile(source: LineSource): Promise<LineProfile | null> {
    if (!source.userId) return Promise.resolve(null);
    const path =
      source.type === "group"
        ? `/v2/bot/group/${source.groupId}/member/${source.userId}`
        : source.type === "room"
          ? `/v2/bot/room/${source.roomId}/member/${source.userId}`
          : `/v2/bot/profile/${source.userId}`;
    return cached(`profile:${path}`, 60 * 60_000, () => this.getJson<LineProfile>(LINE_API + path));
  }

  /** グループ名 / 複数人トークは名前が無いので固定文言 */
  async getChatName(source: LineSource): Promise<string> {
    if (source.type === "group") {
      const summary = await cached(`group:${source.groupId}`, 60 * 60_000, () =>
        this.getJson<{ groupName?: string }>(`${LINE_API}/v2/bot/group/${source.groupId}/summary`),
      );
      return summary?.groupName || "LINEグループ";
    }
    if (source.type === "room") return "LINE複数人トーク";
    return "LINE";
  }

  /**
   * 動画・音声はLINE側の変換が終わるまで取得できないことがあるため、
   * 変換ステータスを確認する。ステータスAPIが使えない場合は "succeeded" 扱いで先に進む。
   */
  async waitForTranscoding(messageId: string, attempts = 6, intervalMs = 2000): Promise<TranscodingStatus> {
    for (let i = 0; i < attempts; i++) {
      const body = await this.getJson<{ status?: string }>(
        `${LINE_DATA_API}/v2/bot/message/${messageId}/content/transcoding`,
      );
      if (!body || body.status === "succeeded") return "succeeded";
      if (body.status === "failed") return "failed";
      await this.deps.sleep(intervalMs);
    }
    return "timeout";
  }

  /** メッセージのバイナリ(画像/動画/音声/ファイル)を取得。失敗時は LineApiError */
  async getContent(messageId: string, range?: string | null): Promise<Response> {
    const headers = new Headers(this.headers);
    if (range) headers.set("range", range);
    const res = await this.deps.fetch(`${LINE_DATA_API}/v2/bot/message/${messageId}/content`, {
      headers,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new LineApiError(res.status, `LINE content API returned ${res.status}`);
    }
    return res;
  }
}
