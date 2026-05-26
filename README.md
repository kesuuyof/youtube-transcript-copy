# YouTube Transcript Copy

YouTube動画のトランスクリプトを、Claude / ChatGPT 用のプロンプト付きでクリップボードにワンクリックコピーするChrome拡張機能です。

## 機能

- 拡張機能アイコンをクリックするだけで、現在見ているYouTube動画のトランスクリプトを取得
- 要約用プロンプトと動画メタ情報（タイトル、URL等）を付けてクリップボードにコピー
- そのままclaude.aiやChatGPTに貼り付けるだけで要約完了
- 字幕優先順位: 日本語 → 英語 → その他
- 成功・失敗時はページ右下にトースト表示、アイコンに ✓ バッジ表示（OS通知も併用）

## 取得経路（順に試行）

1. **YouTube の timedtext API** — 手動字幕の動画はここで取得
2. **youtubei/v1/get_transcript API**（SAPISID 認証付き）— ログイン状態のCookieからハッシュを計算して認証
3. **DOM 文字起こしパネルからのスクレイプ** — 新形式 (`transcript-segment-view-model`) と旧形式 (`ytd-transcript-segment-renderer`) 両対応。必要なら自動でパネルを開く

ASR（自動生成）字幕や、API が空を返すケースもこれでカバーします。

## インストール手順

1. このフォルダをローカルの好きな場所に置く（例: `~/chrome-extensions/youtube-transcript-copy/`）
2. Chrome で `chrome://extensions` を開く
3. 右上の「**デベロッパーモード**」をONにする
4. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
5. このフォルダ（`manifest.json` がある階層）を選択

## 使い方

1. YouTube で要約したい動画を開く（`youtube.com/watch?v=...`）
2. ツールバーの拡張機能アイコンをクリック
3. 右下に「✅ トランスクリプトをコピーしました」のトーストが出たら成功
4. Claude のチャット欄に `Cmd+V` で貼り付けて送信

## カスタマイズ

### プロンプトを変更したい
`content.js` の `buildPrompt` 関数を編集してください。

### 字幕の優先言語を変えたい
`content.js` の以下の部分の順序を変更:
```js
const track =
  captionTracks.find((t) => t.languageCode === "ja") ||
  captionTracks.find((t) => t.languageCode === "en") ||
  captionTracks[0];
```

英語学習用に常に英語を取りたいなら、`ja` と `en` の順番を入れ替えてください。

## トラブルシューティング

| 症状 | 原因 | 対応 |
|------|------|------|
| 「この動画には字幕がありません」 | 字幕未対応の動画 | 仕様。手動でやるしかない |
| 「字幕本文を自動取得できませんでした」 | 広告ブロッカー等が API リクエストを妨害 / YouTube 側の制限 | 概要欄を展開して「文字起こしを表示」を**手動で**開いてから再度アイコンをクリック |
| OS の通知が出ない | macOS の通知設定で Chrome が無効 | システム設定 → 通知 → Google Chrome を許可（ページ内トーストは出るので必須ではない） |
| 別の動画に切り替えた直後に古いトランスクリプトがコピーされる | SPA ナビゲーションでのキャッシュ問題 | 直っているはず。再現したら issue で報告 |

## プライバシー

- 拡張機能は **YouTube ページ上でのみ動作** します（manifest の host_permissions が `youtube.com` 限定）
- innertube API 認証のため `document.cookie` から SAPISID 系 Cookie を読みます。読んだ値はその場で SHA-1 ハッシュにして `youtube.com` 自身のAPIへの `Authorization` ヘッダにだけ使用します。**第三者には送信しません**
- 取得したトランスクリプトはローカルのクリップボードに書き込むだけです

## ファイル構成

```
youtube-transcript-copy/
├── manifest.json     # 拡張機能設定（MV3）
├── background.js     # Service Worker: アイコンクリック / 通知 / バッジ表示
├── content.js        # 動画ページに注入される処理本体（MAIN world）
├── icons/
│   └── icon128.png
└── README.md
```
