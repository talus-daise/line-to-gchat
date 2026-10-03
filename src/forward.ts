import type { Deps } from "./deps";
import {
  ChatApiError,
  buildCardMessage,
  buttonsWidget,
  chunkText,
  escapeChatText,
  escapeHtml,
  imageWidget,
  postToChat,
  sanitizeInline,
  textWidget,
  type ChatMessage,
} from "./gchat";
import type { LineClient } from "./line";
import { buildMediaLinks, type MediaKind, type MediaLinks } from "./media";
import type { Env, LineEmoji, LineEvent, LineMessage, LineSource } from "./types";
import { formatBytes, formatDuration } from "./util";

export interface ForwardContext {
  env: Env;
  deps: Deps;
  /** メディアURLの origin (例: https://line-to-gchat.xxx.workers.dev) */
  baseUrl: string;
  line: LineClient;
  /** 転送対象のID。空Setならすべてのグループ/複数人トークを転送する */
  targets: Set<string>;
}

interface Who {
  name: string;
  avatarUrl?: string;
  chatName: string;
}

const MESSAGE_LABEL: Record<string, string> = {
  text: "テキスト",
  image: "画像",
  video: "動画",
  audio: "音声",
  file: "ファイル",
  location: "位置情報",
  sticker: "スタンプ",
};

/** 空文字や未設定なら空Set。空Setは「すべてのグループ/複数人トーク」を意味する */
export function parseTargets(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
}

/** グループ→groupId / 複数人トーク→roomId / 1:1→null */
export function chatIdOf(source: LineSource): string | null {
  if (source.type === "group") return source.groupId;
  if (source.type === "room") return source.roomId;
  return null;
}

/**
 * LINE絵文字(商品絵文字)は本文中に `$` のプレースホルダで入ってくる。
 * そのままだと `$` が表示されてしまうので、位置(UTF-16)を頼りに置き換える。
 */
export function applyLineEmojis(text: string, emojis: LineEmoji[] | undefined): string {
  if (!emojis?.length) return text;
  let out = text;
  for (const e of [...emojis].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, e.index) + "□" + out.slice(e.index + e.length);
  }
  return out;
}

export async function processEvents(events: LineEvent[], ctx: ForwardContext): Promise<void> {
  // 順序を保つため直列で処理する
  for (const ev of events) {
    try {
      await processEvent(ev, ctx);
    } catch (err) {
      console.error("[forward] unexpected error:", describeError(err));
    }
  }
}

async function processEvent(ev: LineEvent, c: ForwardContext): Promise<void> {
  // Botがグループに招待されたときは、設定用にIDをログへ出す
  if (ev.type === "join" && ev.source) {
    console.log(`[line] bot joined: ${describeSource(ev.source)}`);
    return;
  }
  if (ev.type !== "message" || !ev.message || !ev.source) return;

  const chatId = chatIdOf(ev.source);
  if (!chatId) return; // 1:1トークは対象外
  if (c.targets.size > 0 && !c.targets.has(chatId)) {
    // wrangler tail でこのログからIDを確認し、TARGET_LINE_GROUP_IDS に登録する
    console.log(`[line] skipped (not in TARGET_LINE_GROUP_IDS): ${describeSource(ev.source)}`);
    return;
  }

  const [profile, chatName] = await Promise.all([
    c.line.getMemberProfile(ev.source),
    c.line.getChatName(ev.source),
  ]);
  const who: Who = {
    name: profile?.displayName || "LINEユーザー",
    avatarUrl: profile?.pictureUrl,
    chatName,
  };

  try {
    await forwardMessage(ev.message, who, c);
  } catch (err) {
    console.error(`[forward] ${ev.message.type} ${ev.message.id} failed:`, describeError(err));
    const label = MESSAGE_LABEL[ev.message.type] ?? ev.message.type;
    await postToChat(c.deps, c.env.GOOGLE_CHAT_WEBHOOK_URL, {
      text:
        `⚠️ *${sanitizeInline(who.name)}* のLINEメッセージ（${label}）を転送できませんでした` +
        `（${friendlyReason(err)}）。LINEアプリで直接ご確認ください。`,
    }).catch((e) => console.error("[forward] failed to post error notice:", describeError(e)));
  }
}

async function forwardMessage(msg: LineMessage, who: Who, c: ForwardContext): Promise<void> {
  const send = (m: ChatMessage) => postToChat(c.deps, c.env.GOOGLE_CHAT_WEBHOOK_URL, m);
  const head = `*${sanitizeInline(who.name)}*  ·  ${sanitizeInline(who.chatName)}`;
  const subtitle = `LINE・${who.chatName}`;

  /** カード送信。カードが拒否(400)されたらリンク付きテキストにフォールバック */
  const sendCard = async (
    label: string,
    widgets: unknown[],
    fallbackText: string,
    extraSubtitle = "",
  ) => {
    const card = buildCardMessage({
      id: `line-${msg.id}`,
      title: who.name,
      subtitle: `${subtitle}${extraSubtitle ? `・${extraSubtitle}` : ""}`,
      avatarUrl: who.avatarUrl,
      widgets,
    });
    try {
      await send(card);
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 400) {
        console.warn(`[forward] card rejected for ${label}, falling back to text: ${err.detail}`);
        await send({ text: `${head}\n${fallbackText}` });
        return;
      }
      throw err;
    }
  };

  const links = (kind: MediaKind, filename?: string): Promise<MediaLinks> =>
    buildMediaLinks({
      secret: c.env.MEDIA_SIGNING_SECRET,
      baseUrl: c.baseUrl,
      kind,
      messageId: msg.id,
      filename,
    });

  switch (msg.type) {
    case "text": {
      const body = escapeChatText(applyLineEmojis(msg.text, msg.emojis));
      const chunks = chunkText(body);
      for (const [i, chunk] of chunks.entries()) {
        await send({ text: i === 0 ? `${head}\n${chunk}` : chunk });
      }
      return;
    }

    case "image": {
      const media = await links("image");
      const set = msg.imageSet && msg.imageSet.total > 1 ? `${msg.imageSet.index}/${msg.imageSet.total}` : "";
      await sendCard(
        "image",
        [
          imageWidget(media.url, media.filename),
          buttonsWidget([
            { text: "開く", url: media.url },
            { text: "ダウンロード", url: media.downloadUrl },
          ]),
        ],
        `🖼 画像 ${media.url}`,
        set,
      );
      return;
    }

    case "video":
    case "audio": {
      const media = await links(msg.type);
      const isVideo = msg.type === "video";
      const dur = formatDuration(msg.duration);
      const title = `${isVideo ? "🎬 動画" : "🎧 音声メッセージ"}${dur ? `（${dur}）` : ""}`;
      await sendCard(
        msg.type,
        [
          textWidget(title),
          buttonsWidget([
            { text: isVideo ? "再生" : "聞く", url: media.url },
            { text: "ダウンロード", url: media.downloadUrl },
          ]),
        ],
        `${title} ${media.url}`,
      );
      return;
    }

    case "file": {
      const media = await links("file", msg.fileName);
      await sendCard(
        "file",
        [
          textWidget(`📎 <b>${escapeHtml(media.filename)}</b><br>${formatBytes(msg.fileSize)}`),
          buttonsWidget([{ text: "ダウンロード", url: media.downloadUrl }]),
        ],
        `📎 ${media.filename} (${formatBytes(msg.fileSize)})\n${media.downloadUrl}`,
      );
      return;
    }

    case "location": {
      const mapUrl = `https://www.google.com/maps?q=${msg.latitude},${msg.longitude}`;
      const lines = [head, "📍 位置情報を共有しました"];
      if (msg.title) lines.push(escapeChatText(msg.title));
      if (msg.address) lines.push(escapeChatText(msg.address));
      lines.push(mapUrl);
      await send({ text: lines.join("\n") });
      return;
    }

    case "sticker": {
      // LINE公式のスタンプ画像CDN (非公式パスのため、表示できない場合はキーワードだけが残る)
      const imageUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(msg.stickerId)}/android/sticker.png`;
      const kw = msg.keywords?.slice(0, 3).join(", ") ?? "";
      await sendCard(
        "sticker",
        [
          imageWidget(imageUrl, kw || "スタンプ"),
          textWidget(`🏷 スタンプ${kw ? `（${escapeHtml(kw)}）` : ""}`),
        ],
        `🏷 スタンプ${kw ? `（${escapeChatText(kw)}）` : ""}`,
        "スタンプ",
      );
      return;
    }

    default: {
      const type = (msg as { type: string }).type;
      await send({ text: `${head}\n（未対応のメッセージ種別: ${escapeChatText(type)}）` });
    }
  }
}

function friendlyReason(err: unknown): string {
  if (err instanceof ChatApiError) return `Google Chatへの送信に失敗しました (HTTP ${err.status})`;
  return "内部エラー";
}

function describeSource(source: LineSource): string {
  return source.type === "group"
    ? `group ${source.groupId}`
    : source.type === "room"
      ? `room ${source.roomId}`
      : "1:1 chat";
}

function describeError(err: unknown): string {
  if (err instanceof ChatApiError) return `${err.message}: ${err.detail}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
