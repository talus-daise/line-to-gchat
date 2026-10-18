import { sanitizeInline } from "./gchat";
import { previewOf } from "./line-text";
import type { Env, LineMessage } from "./types";

/**
 * 【返信（引用）の表示】
 *
 * Google Chat の Incoming Webhook には引用の仕組みが無く、認証付き Chat API を使わない限り
 * ネイティブな引用はできない。そこで、転送したメッセージの要約を KV に覚えておき、
 * 誰かが引用返信してきたときに「引用ブロック」として本文の前にテキストで添える。
 *
 * - LINE の Webhook は引用元の `quotedMessageId` しか渡さず、内容は再取得できない。
 *   そのため引用元の内容は「転送時に自分で保存したもの」から引く。
 * - KV 未設定・未保存・期限切れの場合は、引用を付けずに通常どおり転送する。
 */

/** 引用元として保持する転送メッセージの要約 */
export interface QuotedPreview {
  author: string;
  preview: string;
}

/** 引用元を保持する期間(秒)。LINE側の内容保持期間に合わせた控えめな既定値 */
export const REPLY_CONTEXT_TTL_SECONDS = 60 * 60 * 24 * 30;

function keyOf(messageId: string): string {
  return `line:${messageId}`;
}

/**
 * 転送したメッセージの要約を KV に保存する。後でこのメッセージを引用返信されたときに使う。
 * 保存の失敗で転送自体を止めたくないので、例外は投げない。
 */
export async function storeForwarded(env: Env, msg: LineMessage, author: string): Promise<void> {
  const kv = env.REPLY_CONTEXT;
  if (!kv) return;
  try {
    const value: QuotedPreview = { author, preview: previewOf(msg) };
    await kv.put(keyOf(msg.id), JSON.stringify(value), {
      expirationTtl: REPLY_CONTEXT_TTL_SECONDS,
    });
  } catch (err) {
    console.warn(`[reply] failed to store context for ${msg.id}: ${(err as Error).message}`);
  }
}

/** 引用元のメッセージIDから要約を引く。未保存・期限切れ・KV未設定なら null */
export async function lookupQuoted(env: Env, messageId: string): Promise<QuotedPreview | null> {
  const kv = env.REPLY_CONTEXT;
  if (!kv) return null;
  try {
    const value = (await kv.get(keyOf(messageId), "json")) as QuotedPreview | null;
    if (value && typeof value.author === "string" && typeof value.preview === "string") {
      return value;
    }
  } catch (err) {
    console.warn(`[reply] failed to load context for ${messageId}: ${(err as Error).message}`);
  }
  return null;
}

/**
 * 引用元を Google Chat の引用ブロック(行頭 `> `)にする。
 * 末尾に改行を付けて返すので、そのまま本文の前に連結できる。
 */
export function quoteBlock(quoted: QuotedPreview): string {
  const author = sanitizeInline(quoted.author);
  const preview = sanitizeInline(quoted.preview);
  const body = author ? `${author}: ${preview}` : preview;
  return `> 返信元 · ${body}\n`;
}
