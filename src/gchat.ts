import type { Deps } from "./deps";

export interface ChatMessage {
  text?: string;
  cardsV2?: unknown[];
}

export class ChatApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Google Chat webhook returned ${status}`);
    this.name = "ChatApiError";
  }
}

/** Google Chat のテキスト上限(4096文字)に余裕を持たせた分割サイズ */
const TEXT_LIMIT = 3800;

/**
 * LINEの本文をGoogle Chatのテキストとして安全に表示するためのエスケープ。
 * - `<users/all>` `<users/123>` はメンションとして解釈されてしまう
 * - `<https://example.com|表示名>` は本当のリンク先を隠せてしまう
 * どちらも `<` を全角にして無効化する。
 */
export function escapeChatText(s: string): string {
  return s.replace(/<(?=(?:users\/|[^>\n]*\|))/g, "＜");
}

/** 太字などの書式内に入れる名前用。書式記号を全角にして崩れを防ぐ */
export function sanitizeInline(s: string): string {
  return s
    .replace(/[*_~`]/g, (c) => ({ "*": "＊", _: "＿", "~": "～", "`": "｀" })[c] ?? c)
    .replace(/[<>]/g, (c) => (c === "<" ? "＜" : "＞"))
    .replace(/\s+/g, " ")
    .trim();
}

/** Card の textParagraph は簡易HTMLなのでエスケープが必要 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 長文を改行位置優先で分割する (サロゲートペアは分断しない) */
export function chunkText(text: string, limit = TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  chunks.push(rest);
  return chunks;
}

// ---- Card v2 helpers ----

export function textWidget(html: string): unknown {
  return { textParagraph: { text: html } };
}

export function imageWidget(imageUrl: string, altText: string, openUrl = imageUrl): unknown {
  return { image: { imageUrl, altText, onClick: { openLink: { url: openUrl } } } };
}

export function buttonsWidget(buttons: { text: string; url: string }[]): unknown {
  return {
    buttonList: {
      buttons: buttons.map((b) => ({ text: b.text, onClick: { openLink: { url: b.url } } })),
    },
  };
}

export interface CardParams {
  id: string;
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  widgets: unknown[];
}

export function buildCardMessage(p: CardParams): ChatMessage {
  return {
    cardsV2: [
      {
        cardId: p.id,
        card: {
          header: {
            title: p.title,
            ...(p.subtitle ? { subtitle: p.subtitle } : {}),
            ...(p.avatarUrl?.startsWith("https://")
              ? { imageUrl: p.avatarUrl, imageType: "CIRCLE" }
              : {}),
          },
          sections: [{ widgets: p.widgets }],
        },
      },
    ],
  };
}

// ---- 送信 ----

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

/**
 * Incoming Webhook へ POST する。
 * スペースあたりの書き込みレート制限(約1件/秒)で 429 になることがあるため、
 * 429/5xx/ネットワークエラーは指数バックオフで再試行する。
 * ※ Webhook URL にはキーとトークンが含まれるためログには出さない。
 */
export async function postToChat(
  deps: Deps,
  webhookUrl: string,
  message: ChatMessage,
  maxAttempts = 4,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await deps.sleep(backoff(attempt));
      continue;
    }

    if (res.ok) {
      await res.body?.cancel();
      return;
    }

    const detail = (await res.text().catch(() => "")).slice(0, 500);
    const err = new ChatApiError(res.status, detail);
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      lastError = err;
      const retryAfter = Number(res.headers.get("retry-after"));
      await deps.sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt));
      continue;
    }
    throw err;
  }
  throw lastError instanceof Error ? lastError : new Error("Google Chat post failed");
}
