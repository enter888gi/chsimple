<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>heya — T</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #efece6; --surface: #f7f4ee; --sunken: #e7e2d8; --fg: #161513;
      --muted: #6b6760; --subtle: #8a857c; --border: #d8d2c6; --accent: #21564a;
      --accent-fg: #f4f1ea; --mine: #1c1b19; --mine-fg: #f6f3ec; --theirs: #e4dfd6;
      --danger: #8f3d32;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg);
      font-family: "Zen Kaku Gothic New", "Hiragino Sans", sans-serif; }
    button { font: inherit; cursor: pointer; }
    input, textarea { font: inherit; }
    .shell { min-height: 100dvh; display: flex; justify-content: center; }
    .phone { width: 100%; max-width: 28rem; min-height: 100dvh; background: var(--surface);
      border-left: 1px solid var(--border); border-right: 1px solid var(--border);
      display: flex; flex-direction: column; }
    header.bar { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
      border-bottom: 1px solid var(--border); }
    .mark { width: 28px; height: 28px; border: 1.5px solid var(--fg); border-radius: 8px;
      display: grid; place-items: center; flex: none; }
    .mark i { width: 8px; height: 8px; border: 1.5px solid var(--accent); border-radius: 99px; }
    h1 { font-size: 15px; margin: 0; font-weight: 700; letter-spacing: -0.02em; }
    p.sub { margin: 0; color: var(--muted); font-size: 12px; }
    .grow { flex: 1; }
    .iconbtn { width: 40px; height: 40px; border: 0; background: transparent; border-radius: 10px; color: var(--fg); }
    .iconbtn:hover { background: var(--sunken); }
    .hero { padding: 48px 24px 16px; }
    .hero h2 { font-size: 32px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.03em; font-weight: 700; }
    .hero p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
    form.stack { padding: 8px 24px 32px; display: flex; flex-direction: column; gap: 12px; }
    label { font-size: 12px; font-weight: 500; color: var(--muted); }
    input, textarea { width: 100%; border: 1px solid var(--border); background: var(--bg);
      border-radius: 12px; padding: 12px 12px; color: var(--fg); outline: none; }
    input:focus, textarea:focus { box-shadow: 0 0 0 2px var(--accent); }
    .btn { height: 48px; border: 0; border-radius: 14px; background: var(--accent); color: var(--accent-fg);
      font-weight: 500; }
    .btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
    .hint { font-size: 12px; color: var(--subtle); line-height: 1.5; }
    .log { flex: 1; overflow: auto; padding: 16px 14px 8px; display: flex; flex-direction: column; gap: 8px; }
    .bubble { max-width: 78%; padding: 10px 12px; border-radius: 18px; font-size: 14px; line-height: 1.5; }
    .row { display: flex; flex-direction: column; }
    .row.me { align-items: flex-end; }
    .row.them { align-items: flex-start; }
    .me .bubble { background: var(--mine); color: var(--mine-fg); border-bottom-right-radius: 6px; }
    .them .bubble { background: var(--theirs); color: var(--fg); border-bottom-left-radius: 6px; }
    .who { font-size: 11px; color: var(--subtle); margin: 0 4px 4px; }
    .thumb { width: 168px; height: 112px; object-fit: cover; border-radius: 14px; display: block; cursor: zoom-in; background: var(--sunken); }
    .composer { display: flex; gap: 8px; padding: 10px 12px calc(12px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border); align-items: flex-end; }
    .composer textarea { min-height: 44px; max-height: 120px; border-radius: 22px; padding: 10px 14px; resize: none; }
    .send { width: 44px; height: 44px; border: 0; border-radius: 99px; background: var(--accent); color: var(--accent-fg); flex: none; }
    .typing-indicator { font-size: 11px; color: var(--subtle); padding: 0 16px 6px; min-height: 18px; }
    .pending { margin: 0 16px 8px; }
    .pending img { width: 120px; height: 80px; object-fit: cover; border-radius: 12px; }
    .banner { margin: 12px 16px 0; padding: 10px 12px; background: var(--sunken); border-radius: 12px; font-size: 12px; color: var(--muted); }
    .lightbox { position: fixed; inset: 0; background: rgb(22 21 19 / 0.88); display: grid; place-items: center; z-index: 40; }
    .lightbox img { max-width: 92vw; max-height: 88vh; border-radius: 8px; }
    .err { color: var(--danger); font-size: 12px; }
    .menu { position: absolute; right: 12px; top: 56px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 6px; min-width: 180px; box-shadow: 0 12px 32px rgb(22 21 19 / 0.08); }
    .menu button { display: block; width: 100%; text-align: left; background: transparent; border: 0; padding: 10px 12px; border-radius: 10px; }
    .menu button:hover { background: var(--sunken); }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <!-- heya exported source | room FBNH9F | 作成者パスワード admin の部屋からのみ書き出し -->
  <div class="shell">
    <div class="phone" id="app"></div>
  </div>
  <script>
    const META = { roomName: "T", code: "FBNH9F" };
    const MEGA_RE = /https?:\/\/mega(?:\.co)?\.nz\/(?:file\/|folder\/|embed\/|#!)[^\s<>"']+/i;
    const dbKey = "heya.export." + META.code;
    const state = load();
    const root = document.getElementById("app");
    let pendingMega = null;
    let menuOpen = false;
    let lightUrl = null;
    let isTyping = false;
    let typingTimer = null;

    function load() {
      try { return JSON.parse(localStorage.getItem(dbKey)) || seed(); }
      catch { return seed(); }
    }
    function seed() {
      return { messages: [], nick: "書き出し" };
    }
    function save() { localStorage.setItem(dbKey, JSON.stringify(state)); }
    function escape(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        if (c === "&") return String.fromCharCode(38) + "amp;";
        if (c === "<") return String.fromCharCode(38) + "lt;";
        if (c === ">") return String.fromCharCode(38) + "gt;";
        if (c === '"') return String.fromCharCode(38) + "quot;";
        return String.fromCharCode(38) + "#39;";
      });
    }
    function render() {
      if (lightUrl) {
        root.innerHTML = '<div class="lightbox" id="lb"><img alt="" src="' + lightUrl + '"></div>';
        document.getElementById("lb").onclick = () => { lightUrl = null; render(); };
        return;
      }
      const msgs = state.messages.map((m) => {
        if (m.kind === "mega") {
          return '<div class="row me"><div class="bubble" style="padding:6px">'
            + (m.dataUrl
              ? '<img class="thumb" data-full="' + escape(m.dataUrl) + '" src="' + escape(m.dataUrl) + '" alt="">'
              : '<div class="thumb"></div>')
            + '</div><button class="iconbtn" data-del="' + m.id + '" style="width:28px;height:28px;opacity:.5">×</button></div>';
        }
        return '<div class="row me"><div class="bubble">' + escape(m.body) + '</div>'
          + '<button class="iconbtn" data-del="' + m.id + '" style="width:28px;height:28px;opacity:.5">×</button></div>';
      }).join("");
      root.innerHTML = `
        <header class="bar">
          <div class="mark"><i></i></div>
          <div class="grow"><h1>${escape(META.roomName)}</h1><p class="sub">書き出したHTMLソース · ${escape(META.code)}</p></div>
          <button class="iconbtn" id="menuBtn" aria-label="メニュー">⋯</button>
        </header>
        <div class="banner">このファイルは設定画面から書き出した単一HTMLです。見た目の保管用で、MEGA画像はリンク先へは飛びません。会話の同期は公開中のheya本体で行ってください。</div>
        ${menuOpen ? '<div class="menu"><button id="wipe">やりとりを消す</button><button id="src">ソースを表示</button></div>' : ''}
        <div class="log" id="log">${msgs || '<p class="sub" style="margin:auto;padding:32px 0">まだ言葉はありません</p>'}</div>
        <div class="typing-indicator" id="typing">${isTyping ? escape(state.nick) + ' が入力中...' : ''}</div>
        ${pendingMega ? '<div class="pending"><img alt="" src="' + pendingMega.dataUrl + '"><div class="hint">送信前のサムネイル</div></div>' : ''}
        <form class="composer" id="composer">
          <textarea id="text" rows="1" placeholder="メッセージ、または MEGA リンク"></textarea>
          <button class="send" type="submit">送信</button>
        </form>
      `;
      const log = document.getElementById("log");
      log.scrollTop = log.scrollHeight;
      document.getElementById("menuBtn").onclick = () => { menuOpen = !menuOpen; render(); };
      const wipe = document.getElementById("wipe");
      if (wipe) wipe.onclick = () => { state.messages = []; save(); menuOpen = false; render(); };
      const src = document.getElementById("src");
      if (src) src.onclick = () => { alert("このページ自体が書き出したHTMLソースです。ブラウザの保存で保管できます。"); };
      log.querySelectorAll("[data-full]").forEach((img) => {
        img.addEventListener("click", () => { lightUrl = img.getAttribute("data-full"); render(); });
      });
      log.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.messages = state.messages.filter((m) => m.id !== btn.getAttribute("data-del"));
          save(); render();
        });
      });
      const form = document.getElementById("composer");
      const ta = document.getElementById("text");
      ta.addEventListener("input", () => {
        const found = ta.value.match(MEGA_RE);
        if (found) {
          ta.value = ta.value.replace(found[0], "").trim();
          pendingMega = { dataUrl: placeholderThumb(), url: found[0] };
          render();
          document.getElementById("text").focus();
          return;
        }

        // 入力中表示のコントロール
        if (ta.value.trim().length > 0) {
          if (!isTyping) {
            isTyping = true;
            document.getElementById("typing").innerText = state.nick + " が入力中...";
          }
          clearTimeout(typingTimer);
          typingTimer = setTimeout(() => {
            isTyping = false;
            const el = document.getElementById("typing");
            if (el) el.innerText = "";
          }, 2000);
        } else {
          isTyping = false;
          const el = document.getElementById("typing");
          if (el) el.innerText = "";
        }
      });
      form.onsubmit = (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        isTyping = false;
        clearTimeout(typingTimer);
        if (pendingMega) {
          state.messages.push({ id: String(Date.now()), kind: "mega", dataUrl: pendingMega.dataUrl });
          pendingMega = null;
        }
        if (body) state.messages.push({ id: String(Date.now()+1), kind: "text", body });
        save(); render();
      };
    }
    function placeholderThumb() {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="336" height="224"><rect fill="#e7e2d8" width="336" height="224" rx="16"/><rect fill="#21564a" x="148" y="92" width="40" height="28" rx="4" opacity=".35"/><circle fill="#21564a" cx="160" cy="102" r="6" opacity=".5"/></svg>';
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    }
    render();
  </script>
</body>
</html>
