// chrome.scripting.executeScript で MAIN world に注入される
// 最後の式（async IIFEの戻り値=Promise）が解決された値が background.js に返る

(async () => {
  try {
    // 現在の動画 ID を URL から確実に取得（SPA 遷移後のズレ防止）
    const currentVideoId = new URLSearchParams(location.search).get("v");
    if (!currentVideoId) {
      return fail("URL から動画 ID を取得できませんでした。");
    }

    // playerResponse を取得（必ず currentVideoId と一致するものを使う）
    const playerResponse = getPlayerResponse(currentVideoId);
    if (!playerResponse) {
      return fail("playerResponse が取得できませんでした。ページをリロードしてみてください。");
    }

    const videoDetails = playerResponse.videoDetails || {};
    const title = videoDetails.title || "Unknown title";
    const author = videoDetails.author || "Unknown";
    const videoId = videoDetails.videoId || "";
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // 公開日（microformat から取得。publishDate 優先、なければ uploadDate）
    const microformat = playerResponse.microformat?.playerMicroformatRenderer || {};
    const publishDate = formatDate(microformat.publishDate || microformat.uploadDate || "");

    const captionTracks =
      playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return fail("この動画には字幕（トランスクリプト）がありません。");
    }

    // 2. トラックを優先順位で選ぶ: 日本語 > 英語 > 1番目
    const track =
      captionTracks.find((t) => t.languageCode === "ja") ||
      captionTracks.find((t) => t.languageCode === "en") ||
      captionTracks[0];

    if (!track?.baseUrl) {
      return fail("字幕トラックのURLが取得できませんでした。");
    }

    // 3. 字幕を取得: まず timedtext API を複数フォーマットで試し、空なら DOM パネルから取得
    const attempts = [
      track.baseUrl,
      track.baseUrl + "&fmt=json3",
      track.baseUrl + "&fmt=srv3",
      track.baseUrl + "&fmt=srv1"
    ];

    let transcript = "";
    for (const u of attempts) {
      const r = await fetchTranscriptDetailed(u);
      if (r.transcript) {
        transcript = r.transcript;
        break;
      }
    }

    if (!transcript) {
      // ASR 等で timedtext API が空を返す場合は youtubei/v1/get_transcript を試す
      transcript = await fetchViaInnertube();
      if (!transcript) {
        // 最終フォールバック: DOM パネルスクレイプ
        transcript = await scrapeTranscriptPanel();
      }
      if (!transcript) {
        return fail(
          "字幕本文を自動取得できませんでした。\n" +
          "対処: 概要欄を展開して「文字起こしを表示」を手動で開いてから、もう一度アイコンを押してください。"
        );
      }
    }

    // 4. プロンプト付きの最終テキストを生成
    const finalText = buildPrompt({
      title,
      author,
      url,
      publishDate,
      languageCode: track.languageCode,
      transcript
    });

    // 5. クリップボードへ書き込み（MAIN world、ユーザージェスチャ起点なので通常成功する）
    let copied = false;
    try {
      await navigator.clipboard.writeText(finalText);
      copied = true;
    } catch (e) {
      // フォールバックは background 側で対応する
      copied = false;
    }

    // 6. ページ内トーストで成功フィードバック
    showToast(`✅ トランスクリプトをコピーしました（${finalText.length.toLocaleString()}文字）`);

    return {
      ok: true,
      copied,
      title,
      charCount: finalText.length,
      finalText: copied ? undefined : finalText
    };
  } catch (err) {
    return fail(`スクリプト実行エラー: ${err && err.message ? err.message : String(err)}`);
  }

  // --- ヘルパー関数 ---

  async function computeSAPISIDHash() {
    const cookies = document.cookie.split("; ");
    let sapisid = "";
    // 優先順: __Secure-3PAPISID → SAPISID → __Secure-1PAPISID
    const keys = ["__Secure-3PAPISID", "SAPISID", "__Secure-1PAPISID"];
    for (const key of keys) {
      const found = cookies.find((c) => c.startsWith(key + "="));
      if (found) {
        sapisid = found.substring(key.length + 1);
        break;
      }
    }
    if (!sapisid) return null;
    const origin = "https://www.youtube.com";
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `${timestamp} ${sapisid} ${origin}`;
    const buf = new TextEncoder().encode(message);
    const hashBuf = await crypto.subtle.digest("SHA-1", buf);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `SAPISIDHASH ${timestamp}_${hex}`;
  }

  async function fetchViaInnertube() {
    try {
      const params = findTranscriptParams();
      if (!params) return "";
      const cfg = window.ytcfg;
      const apiKey = cfg?.data_?.INNERTUBE_API_KEY || cfg?.get?.("INNERTUBE_API_KEY");
      const context = cfg?.data_?.INNERTUBE_CONTEXT || cfg?.get?.("INNERTUBE_CONTEXT");
      if (!apiKey || !context) return "";

      const visitorId = context?.client?.visitorData || "";
      const clientName = context?.client?.clientName || "WEB";
      const clientVersion = context?.client?.clientVersion || "";

      const headers = {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": clientName === "WEB" ? "1" : clientName,
        "X-YouTube-Client-Version": clientVersion,
        "X-Goog-AuthUser": "0",
        "X-Origin": "https://www.youtube.com"
      };
      if (visitorId) headers["X-Goog-Visitor-Id"] = visitorId;

      // SAPISID Cookie から Authorization ヘッダを計算（YouTube ログイン時の認証）
      const auth = await computeSAPISIDHash();
      if (auth) headers["Authorization"] = auth;

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ context, params })
        }
      );
      if (!res.ok) return "";
      const data = await res.json();
      return extractTranscriptFromInnertube(data);
    } catch (e) {
      return "";
    }
  }

  function findTranscriptParams() {
    // ytInitialData の engagementPanels から取得
    const data = window.ytInitialData || findYtInitialDataFromScripts();
    const panels = data?.engagementPanels || [];
    for (const p of panels) {
      const sec = p?.engagementPanelSectionListRenderer;
      if (!sec) continue;
      if (sec.panelIdentifier !== "engagement-panel-searchable-transcript" &&
          sec.targetId !== "engagement-panel-searchable-transcript") {
        continue;
      }
      // continuationItemRenderer か content.sectionListRenderer のいずれかに endpoint がある
      const content = sec.content;
      const cont =
        content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params ||
        content?.sectionListRenderer?.contents?.[0]?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params;
      if (cont) return cont;
    }
    return "";
  }

  function findYtInitialDataFromScripts() {
    const scripts = document.getElementsByTagName("script");
    for (const s of scripts) {
      const text = s.textContent;
      if (!text) continue;
      const idx = text.indexOf("ytInitialData");
      if (idx === -1) continue;
      const eqIdx = text.indexOf("=", idx);
      if (eqIdx === -1) continue;
      const jsonStart = text.indexOf("{", eqIdx);
      if (jsonStart === -1) continue;
      const json = extractBalancedJson(text, jsonStart);
      if (!json) continue;
      try { return JSON.parse(json); } catch (e) {}
    }
    return null;
  }

  function extractTranscriptFromInnertube(data) {
    // 新形式: actions[].updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments[].transcriptSegmentRenderer.snippet.runs[].text
    const actions = data?.actions || [];
    const parts = [];
    for (const act of actions) {
      const tRenderer =
        act?.updateEngagementPanelAction?.content?.transcriptRenderer ||
        act?.appendContinuationItemsAction?.continuationItems?.[0]?.transcriptRenderer;
      if (!tRenderer) continue;

      const segments =
        tRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments ||
        tRenderer?.body?.transcriptBodyRenderer?.cueGroups;

      if (!segments) continue;

      for (const seg of segments) {
        // 新形式
        const r = seg?.transcriptSegmentRenderer;
        if (r) {
          const runs = r?.snippet?.runs;
          if (runs) {
            parts.push(runs.map((x) => x.text || "").join(""));
            continue;
          }
          if (r?.snippet?.simpleText) {
            parts.push(r.snippet.simpleText);
            continue;
          }
        }
        // 旧形式
        const cues = seg?.transcriptCueGroupRenderer?.cues;
        if (cues) {
          for (const c of cues) {
            const t = c?.transcriptCueRenderer?.cue?.simpleText;
            if (t) parts.push(t);
          }
        }
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function showToast(message, variant = "success") {
    const id = "yt-transcript-copy-toast";
    document.getElementById(id)?.remove();
    const el = document.createElement("div");
    el.id = id;
    el.textContent = message;
    const bg = variant === "error"
      ? "rgba(220, 38, 38, 0.95)"   // 赤
      : "rgba(22, 163, 74, 0.95)";  // 緑
    const duration = variant === "error" ? 5000 : 2200;
    Object.assign(el.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "2147483647",
      background: bg,
      color: "#fff",
      padding: "12px 18px",
      borderRadius: "10px",
      fontSize: "14px",
      fontWeight: "600",
      fontFamily: "Roboto, system-ui, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,0.3)",
      opacity: "0",
      transform: "translateY(10px)",
      transition: "opacity 180ms ease, transform 180ms ease",
      pointerEvents: "none",
      maxWidth: "420px",
      whiteSpace: "pre-wrap",
      lineHeight: "1.4"
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(10px)";
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  function fail(message) {
    showToast("❌ " + message, "error");
    return { error: message };
  }

  async function scrapeTranscriptPanel() {
    // 既にパネルが開いていてセグメントが読めるなら、そのまま使う（手動で開いた可能性も含めて尊重）
    const existing = readPanelSegments();
    if (existing) return existing;

    // 開いているのにセグメントが無い場合のみ、リフレッシュのため一度閉じる
    const panel = getTranscriptPanel();
    if (panel && isPanelOpen(panel)) {
      const closeBtn = panel.querySelector('button[aria-label*="Close" i], button[aria-label*="閉じる"]');
      if (closeBtn) {
        closeBtn.click();
        for (let i = 0; i < 20; i++) {
          await sleep(50);
          if (document.querySelectorAll("ytd-transcript-segment-renderer").length === 0) break;
        }
      }
    }

    // 「文字起こしを表示」ボタンを探す。見つからなければ説明欄を展開してから再探索
    let btn = findShowTranscriptButton();
    if (!btn) {
      const expand = findExpandDescriptionButton();
      if (expand) {
        expand.click();
        for (let i = 0; i < 30; i++) {
          await sleep(100);
          btn = findShowTranscriptButton();
          if (btn) break;
        }
      }
    }
    if (!btn) return "";

    fireRealisticClick(btn);

    // パネルが開いてセグメントが現れるまで最大 10 秒待機
    let triedAncestors = false;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const segs = readPanelSegments();
      if (segs) return segs;

      // パネルが開かなければ親要素にもクリックを試す
      if (i === 10 && !triedAncestors) {
        triedAncestors = true;
        const ancestors = [
          btn.closest("ytd-button-renderer"),
          btn.closest("yt-button-shape"),
          btn.closest("ytd-menu-service-item-renderer"),
          btn.parentElement
        ].filter(Boolean);
        for (const a of ancestors) fireRealisticClick(a);
      }
    }
    return "";
  }

  function fireRealisticClick(el) {
    try {
      el.click();
    } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window, composed: true };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("click", opts)); } catch (e) {}
  }

  function findExpandDescriptionButton() {
    // 説明欄の「…もっと見る」ボタン
    return (
      document.querySelector("tp-yt-paper-button#expand") ||
      document.querySelector("ytd-text-inline-expander #expand") ||
      document.querySelector('#description-inline-expander #expand') ||
      Array.from(document.querySelectorAll("tp-yt-paper-button, button")).find((b) => {
        const t = (b.textContent || "").trim();
        return /^(\.\.\.more|もっと見る|…もっと見る|more)$/i.test(t);
      })
    );
  }

  function getTranscriptPanel() {
    // 新形式（modern transcript view）が優先、無ければ旧形式
    return (
      document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]'
      ) ||
      document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
      )
    );
  }

  function isPanelOpen(panel) {
    const v = panel.getAttribute("visibility");
    return v && v.includes("EXPANDED");
  }

  function readPanelSegments() {
    // 新形式 (transcript-segment-view-model) を優先
    let nodes = document.querySelectorAll("transcript-segment-view-model");
    let useNewFormat = nodes.length > 0;

    if (!useNewFormat) {
      // 旧形式フォールバック
      nodes = document.querySelectorAll("ytd-transcript-segment-renderer .segment-text");
      if (!nodes.length) {
        nodes = document.querySelectorAll("ytd-transcript-segment-renderer");
      }
    }
    if (!nodes || nodes.length === 0) return "";

    const text = Array.from(nodes)
      .map((n) => {
        if (useNewFormat) {
          // 新形式: テキスト全体からタイムスタンプ部分を除去
          return stripTimestamp(n.textContent || "");
        }
        const t = n.querySelector?.(".segment-text");
        return (t ? t.textContent : n.textContent || "").trim();
      })
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  }

  function stripTimestamp(text) {
    // 先頭が「タイムスタンプを構成する文字（空白・数字・:・：・分・秒）の連続」かつ
    // その中に少なくとも一つ「分」「秒」「:」「：」が含まれている場合のみ除去する。
    // 例: "秒", "分 1 秒", "0:41", "1:23:45", "1分 8秒"
    return text.replace(/^[\s　\d:：分秒]*[分秒:：][\s　\d:：分秒]*/u, "").trim();
  }

  function findShowTranscriptButton() {
    // 1. 説明欄の専用セクション（最も信頼できる）
    const direct = document.querySelector(
      "ytd-video-description-transcript-section-renderer button, " +
      "ytd-video-description-transcript-section-renderer yt-button-shape button"
    );
    if (direct) return direct;

    // 2. 説明欄の "Show transcript" ボタン（aria-label 完全マッチ寄り）
    const exact = [
      'button[aria-label="Show transcript"]',
      'button[aria-label="文字起こしを表示"]',
      'tp-yt-paper-item[aria-label="Show transcript"]',
      'tp-yt-paper-item[aria-label="文字起こしを表示"]'
    ];
    for (const sel of exact) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // 3. ラベルの曖昧マッチ。ただし transcript パネル内部の要素は除外（検索フォーム等を避ける）
    const panel = getTranscriptPanel();
    const selector = [
      "button",
      "tp-yt-paper-item",
      "ytd-menu-service-item-renderer",
      "ytd-button-renderer",
      "yt-button-shape"
    ].join(", ");
    const re = /^(\s*show transcript\s*|\s*文字起こしを表示\s*|\s*transcript\s*)$/i;
    const looseRe = /transcript|文字起こし/i;
    const nodes = Array.from(document.querySelectorAll(selector));

    // 完全に近いマッチを先に
    for (const b of nodes) {
      if (panel && panel.contains(b)) continue;
      const label = ((b.getAttribute && b.getAttribute("aria-label")) || "").trim();
      const text = (b.textContent || "").trim();
      if (re.test(label) || re.test(text)) return b;
    }
    // 緩い部分マッチ（input や search を含むものは除外）
    for (const b of nodes) {
      if (panel && panel.contains(b)) continue;
      const label = ((b.getAttribute && b.getAttribute("aria-label")) || "") + " " + (b.textContent || "");
      if (looseRe.test(label) && !/search|検索|input/i.test(label)) return b;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fetchTranscriptDetailed(url) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { status: `HTTP ${res.status}`, bodyLen: 0, transcript: "" };
      const body = await res.text();
      if (!body) return { status: "ok", bodyLen: 0, transcript: "" };
      let transcript = "";
      if (body.trim().startsWith("{")) {
        try {
          const json = JSON.parse(body);
          const events = json.events || [];
          transcript = events
            .map((ev) => (ev.segs || []).map((s) => s.utf8 || "").join(""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        } catch (e) {}
      } else {
        const parser = new DOMParser();
        const xml = parser.parseFromString(body, "text/xml");
        const texts = Array.from(xml.getElementsByTagName("text"));
        transcript = texts
          .map((node) => decodeHtmlEntities(node.textContent || ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
      return { status: "ok", bodyLen: body.length, transcript };
    } catch (e) {
      return { status: `err ${e.message || e}`, bodyLen: 0, transcript: "" };
    }
  }

  function getPlayerResponse(expectedVideoId) {
    // 候補を全部集め、videoId 一致 かつ captionTracks があるものを優先する
    const candidates = [];

    try {
      const player = document.getElementById("movie_player");
      const pr = player && typeof player.getPlayerResponse === "function"
        ? player.getPlayerResponse()
        : null;
      if (pr) candidates.push(pr);
    } catch (e) {}

    if (window.ytInitialPlayerResponse) candidates.push(window.ytInitialPlayerResponse);

    const scripts = document.getElementsByTagName("script");
    for (const s of scripts) {
      const text = s.textContent;
      if (!text) continue;
      const idx = text.indexOf("ytInitialPlayerResponse");
      if (idx === -1) continue;
      const eqIdx = text.indexOf("=", idx);
      if (eqIdx === -1) continue;
      const jsonStart = text.indexOf("{", eqIdx);
      if (jsonStart === -1) continue;
      const json = extractBalancedJson(text, jsonStart);
      if (!json) continue;
      try {
        candidates.push(JSON.parse(json));
      } catch (e) {}
    }

    // 1. videoId 一致 かつ captionTracks あり
    for (const c of candidates) {
      if (
        c?.videoDetails?.videoId === expectedVideoId &&
        c?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length
      ) {
        return c;
      }
    }
    // 2. videoId 一致のみ（captions が無い動画の可能性）
    for (const c of candidates) {
      if (c?.videoDetails?.videoId === expectedVideoId) return c;
    }
    return null;
  }

  function extractBalancedJson(text, startIdx) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(startIdx, i + 1);
      }
    }
    return null;
  }

  function decodeHtmlEntities(s) {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }

  function formatDate(raw) {
    if (!raw) return "";
    // microformat の publishDate は "2024-01-15T00:00:00-07:00" や "2024-01-15" の形
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return String(raw).trim();
  }

  function buildPrompt({ title, author, url, publishDate, languageCode, transcript }) {
    const isJa = languageCode === "ja";
    const dateLine = publishDate ? `\n- 公開日: ${publishDate}` : "";
    return `以下はYouTube動画のトランスクリプトです。
内容を日本語で要約してください。

# 出力形式（Markdown）
## 動画情報
- タイトル: ${title}
- チャンネル: ${author}
- URL: ${url}${dateLine}

冒頭にこの動画情報セクションを必ずそのまま含めてください。

## 概要
動画全体の内容を2-3行で。

## 主要なポイント
重要なポイントを箇条書きで5-7個。

## キーワード・概念
動画で紹介された重要な用語や概念があれば、簡単な説明付きで。

## 所感・補足
聞き手が見落としそうな前提知識や、関連トピックがあれば。

# 入力データ
- タイトル: ${title}
- チャンネル: ${author}
- URL: ${url}${dateLine}
- 字幕言語: ${languageCode}${isJa ? "（日本語）" : ""}

# トランスクリプト
${transcript}
`;
  }
})();
