# line-to-gchat

LINEグループ（または複数人トーク）の投稿を、Google Chat のスペースへ自動転送する Cloudflare Worker です。

**クレジットカード登録が不要な Cloudflare の無料プラン（Workers Free）だけで動きます。** 基本はストレージ不要ですが、返信の引用元を表示する機能でだけ Workers KV を使います（未設定でも動作し、その場合は引用が付かないだけです）。

```
LINEグループ ─▶ LINE公式アカウント(Messaging API)
                     │ Webhook (署名検証)
                     ▼
              Cloudflare Worker ─────▶ Google Chat スペース (Incoming Webhook)
                     ▲                         │ 画像/ファイルのリンクを開く
                     └── 署名付きURLで中継 ◀─────┘
                         (開かれた時にLINEから取得してそのまま返す)
```

## 転送できるもの

| LINEの種類 | Google Chat での表示 |
| --- | --- |
| テキスト | `*送信者*  ·  グループ名` + 本文 (長文は自動分割) |
| LINE絵文字 | 標準のUnicode絵文字に置換（対応表に無いものは `□`）。対応表は `src/line-emoji-map.ts` |
| 画像 | カード（アイコン付き）に画像を表示 + 「開く」「ダウンロード」 |
| 動画 / 音声 | カード + 「再生」「ダウンロード」ボタン |
| ファイル | カード（ファイル名・サイズ）+ 「ダウンロード」ボタン |
| スタンプ | スタンプ画像 + キーワードのカード |
| 位置情報 | 住所 + Googleマップのリンク |

### 返信（引用）の扱い

LINEで誰かが**引用返信**した場合、Google Chat 側でも引用元を表示できます。

- Google Chat の Incoming Webhook には引用の仕組みが無いため、**転送時にメッセージの要約を Workers KV に保存**しておき、引用返信されたときに対応する要約を `> 返信元 · 送信者: 本文` の**引用ブロック**として本文の前に添えます。
- サービスアカウントなどの追加設定は不要です。KV バインディング（「5.（任意）返信の引用を有効にする」）を設定するだけです。
- LINEの Webhook は引用元の `quotedMessageId` しか渡さず、内容は再取得できません。そのため**転送対象外・保存前・保持期間（30日）を過ぎた**メッセージへの引用は表示できず、引用なしで通常転送します。
- LINEが引用に対応するのは**テキストとスタンプ**のみです。
- KV を未設定にすると、この機能だけが無効になります（転送は通常どおり動作）。

### 仕組み上の注意

- **Google Chat の Incoming Webhook はファイルを直接添付できません。** そのため Chat には「このWorkerの署名付きURL」を渡し、**URLが開かれた瞬間にLINEからデータを取得して中継**します（サイズ上限はWorker側にはありません）。
- **LINE側のコンテンツは一定期間で自動削除されます**（期間はLINEの仕様で、公式ドキュメントに具体的な日数の記載はありません）。削除後は、Chat上のリンクを開いても「保存期間が過ぎた」と表示されます。長期保存したい資料は、期限内にダウンロードしてください。
- URL を知っている人は誰でも開けます（HMAC署名付きで、署名なしでは開けません）。共有先には注意してください。
- Bot が参加した **後** のメッセージだけが対象です。過去ログの取得はできません。
- LINEのグループにはBotが参加していることが見えます。**転送を始めることをメンバーに伝えておく**ことをおすすめします。

## セットアップ

### 0. インストール

```bash
npm install
```

### 1. Google Chat の Webhook URL を作る

1. 転送先のスペースを開く
2. スペース名の横の「▼」→ **アプリと統合** → **Webhookを追加**
3. 名前（例: `LINE転送`）を付けて保存し、**Webhook URL をコピー**

> URL にはキーとトークンが含まれます。公開リポジトリやチャットに貼らないでください。
> 組織の管理者設定によっては Webhook を追加できない場合があります。

### 2. LINE Developers で Messaging API チャネルを作る

1. [LINE Developers Console](https://developers.line.biz/console/) でプロバイダーを作成 → **Messaging API チャネル**を作成
2. **チャネルシークレット**（チャネル基本設定）を控える
3. Messaging API設定で **チャネルアクセストークン（長期）** を発行して控える
4. [LINE Official Account Manager](https://manager.line.biz/) → 設定 → 応答設定 で
   - **グループトーク・複数人トークへの参加を許可する** を ON
   - Webhook を ON
   - あいさつメッセージ・応答メッセージは OFF（グループでBotが勝手に喋らないように）
5. Messaging API設定の「Webhookの再送」は **OFF のまま**にしてください（重複転送の原因になります）

### 3. デプロイして Secrets を登録

```bash
npx wrangler login      # 初回のみ (無料アカウントでOK)
npx wrangler deploy

npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GOOGLE_CHAT_WEBHOOK_URL
npx wrangler secret put MEDIA_SIGNING_SECRET      # 例: openssl rand -base64 32 の出力
```

デプロイ後に表示される URL（`https://line-to-gchat.<あなたのサブドメイン>.workers.dev`）を使い、
LINE Developers の **Webhook URL** に `https://…workers.dev/webhook` を設定して **検証** を押します（成功すれば OK）。
「Webhookの利用」も ON にしてください。

> カスタムドメインで配信する場合は `wrangler.jsonc` に `"vars": { "PUBLIC_BASE_URL": "https://example.com" }` を追加できます。
> `MEDIA_SIGNING_SECRET` を変更すると、過去に発行したメディアURLは無効になります。

### 4. 転送対象のグループIDを登録する

1. LINE公式アカウントを転送したいグループに招待する
2. そのグループで何か1件投稿する
3. ログを見る

   ```bash
   npx wrangler tail --format pretty
   ```

   `[line] skipped (not in TARGET_LINE_GROUP_IDS): group Cxxxxxxxx…` と出るので、`C…` の部分がグループIDです。
   （招待直後は `[line] bot joined: group C…` も出ます）
4. 登録する（複数ある場合はカンマ区切り。複数人トークは `R…` のroomId）

   ```bash
   npx wrangler secret put TARGET_LINE_GROUP_IDS
   # → Cxxxxxxxx,Cyyyyyyyy
   ```

これで、対象グループの投稿が Google Chat に流れ始めます。
`TARGET_LINE_GROUP_IDS` を未設定／空にすると、**Botが参加しているすべてのグループ・複数人トーク**が転送されます（1:1トークは対象外）。特定のグループだけ転送したい場合は ID を設定してください。

### 5.（任意）返信の引用を有効にする

1. KV 名前空間を作成する

   ```bash
   npx wrangler kv namespace create REPLY_CONTEXT
   ```

2. 出力された `id` を `wrangler.jsonc` の `kv_namespaces` に貼り付ける

   ```jsonc
   "kv_namespaces": [{ "binding": "REPLY_CONTEXT", "id": "ここに出力されたIDを貼り付け" }]
   ```

3. 再デプロイする

   ```bash
   npx wrangler deploy
   ```

これで、転送済みメッセージへの引用返信が `> 返信元 · …` として表示されます。
未設定のままでも転送は動作し、引用だけが付きません。

## ローカル開発とテスト

```bash
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev                      # wrangler dev

npm run typecheck
npm test                         # 署名検証・転送ロジック・メディア中継などのテスト
```

## 設定一覧

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `LINE_CHANNEL_SECRET` | Secret | Webhook署名の検証に使用 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret | 表示名・グループ名・メディア取得のLINE API呼び出し |
| `GOOGLE_CHAT_WEBHOOK_URL` | Secret | 転送先スペースの Incoming Webhook |
| `MEDIA_SIGNING_SECRET` | Secret | メディアURLの署名鍵 |
| `TARGET_LINE_GROUP_IDS` | Secret | 転送対象のグループID/ルームID（カンマ区切り。空ならすべて転送） |
| `REPLY_CONTEXT` | KV バインディング (任意) | 引用元の要約を保持。設定すると返信の引用が有効になる |
| `PUBLIC_BASE_URL` | Var (任意) | メディアURLの origin を固定したい場合 |

## エンドポイント

| パス | 用途 |
| --- | --- |
| `POST /webhook` | LINE からの Webhook（`x-line-signature` を検証。不正なら 401） |
| `GET /media/:kind/:messageId/:signature/:filename` | 署名付きメディア中継（`?dl=1` で強制ダウンロード。LINEがRangeに対応していれば中継） |
| `GET /` | 動作確認用 |

## トラブルシューティング

- **何も転送されない**: `wrangler tail` を確認。`skipped` が出ていれば `TARGET_LINE_GROUP_IDS` が設定されていて、対象外のIDです。`missing bindings/secrets` が出ていれば Secret の登録漏れです。
- **LINEのWebhook検証が失敗する**: URL末尾が `/webhook` か、`LINE_CHANNEL_SECRET` が正しいかを確認。
- **送信者が「LINEユーザー」になる**: ユーザーがプロフィール情報の利用に同意していない場合、LINE側から表示名が取れません。
- **画像がChatに表示されない / リンクが開けない**: 「保存期間が過ぎた」と出る場合はLINE側で削除済みです。カスタムドメインを使う場合は、WAF/Bot Fight Mode が Google の画像プロキシを弾いていないかも確認してください。
- **429 が続く**: Google Chat の書き込みレート制限（スペースあたり約1件/秒）。Worker側で自動再試行しますが、大量投稿が続くと遅延することがあります。

## 無料プランの目安

- Workers Free は 1日10万リクエストまで。LINEの投稿1件につきWebhook 1回、Chatが画像を読み込むたびにメディア中継が1回です。
- 返信の引用を有効にすると Workers KV の無料枠（読み取り10万/日・書き込み1,000/日・保存1GB）を消費します。転送1件につき書き込み1回です。
- 1回のWebhookで処理するイベントが多い（十数件以上）場合、無料プランの「1リクエストあたり外部通信50回」に近づくことがあります。通常のグループチャットでは問題になりません。

## 今後の拡張の候補

- **長期保存**: LINEの保持期間に左右されたくない場合は、メディアを Workers KV（無料枠あり・1ファイル25MBまで）や Google Drive へ保存してリンクを貼る方式に拡張できます。
- スタンプ画像は LINE の公式CDN（非公式パス）を参照しています。画像が表示できない場合でも、スタンプのキーワードはテキストで残ります。
- 転送は一方向（LINE → Google Chat）です。
