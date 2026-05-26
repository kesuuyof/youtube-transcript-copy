chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes("youtube.com/watch")) {
    await showNotification(
      "YouTube動画ページではありません",
      "YouTubeの動画ページ（youtube.com/watch?v=...）で実行してください。"
    );
    return;
  }

  try {
    // MAIN world で実行して ytInitialPlayerResponse にアクセスする
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      files: ["content.js"]
    });

    const result = results[0]?.result;

    if (!result) {
      await showNotification("エラー", "コンテンツスクリプトの実行に失敗しました。");
      return;
    }

    if (result.error) {
      await showNotification("エラー", result.error);
      return;
    }

    if (!result.ok) {
      await showNotification("エラー", "不明なエラーが発生しました。");
      return;
    }

    // クリップボードへの書き込みは MAIN world ではユーザージェスチャ扱いされない
    // 場合があるため、ここ（service worker 経由）ではなく、別タブ offscreen でも難しい。
    // → MAIN world 側で書き込みを試みつつ、失敗したらここで再試行する設計にする。
    if (result.copied) {
      await flashBadge();
      await showNotification(
        "✅ コピー完了",
        `「${result.title}」のトランスクリプトをコピーしました（${result.charCount}文字）。Claudeに貼り付けてください。`
      );
    } else {
      // フォールバック: タブにクリップボード書き込みだけを別途依頼
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: async (text) => {
          try {
            await navigator.clipboard.writeText(text);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
        args: [result.finalText]
      });
      await flashBadge();
      await showNotification(
        "✅ コピー完了",
        `「${result.title}」のトランスクリプトをコピーしました（${result.charCount}文字）。`
      );
    }
  } catch (err) {
    console.error(err);
    await showNotification("エラー", String(err.message || err));
  }
});

async function flashBadge() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    await chrome.action.setBadgeText({ text: "✓" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
  } catch (e) {
    console.error("Badge error:", e);
  }
}

async function showNotification(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message
    });
  } catch (e) {
    console.error("Notification error:", e);
  }
}
