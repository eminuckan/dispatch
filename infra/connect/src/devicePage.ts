export function dispatchConnectDevicePageHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dispatch Connect</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(92vw, 440px); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 18px; padding: 24px; box-sizing: border-box; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 8px 0; line-height: 1.45; }
    .muted { opacity: .7; font-size: 14px; }
    .stack { display: grid; gap: 10px; margin-top: 18px; }
    input, button { font: inherit; border-radius: 10px; padding: 11px 12px; box-sizing: border-box; width: 100%; }
    input { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); background: Canvas; color: CanvasText; }
    button { border: 0; cursor: pointer; background: #0a36d4; color: white; font-weight: 650; }
    button.secondary { background: color-mix(in srgb, CanvasText 10%, transparent); color: CanvasText; }
    button.danger { background: #9f1d1d; }
    button:disabled { opacity: .55; cursor: default; }
    #request, #decision, #account, #done { display: none; }
    code { font-size: 20px; letter-spacing: .12em; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    #status { min-height: 20px; color: #b42318; font-size: 14px; }
  </style>
</head>
<body>
<main>
  <h1>Dispatch Connect</h1>
  <p class="muted">Authorize a Dispatch CLI without giving it environment access. Environment pairing stays separate.</p>
  <div class="stack">
    <label>
      <span class="muted">Device code</span>
      <input id="code" autocomplete="one-time-code" spellcheck="false" />
    </label>
    <button id="check">Continue</button>
  </div>

  <section id="account" class="stack">
    <p>Sign in to approve this CLI.</p>
    <input id="email" type="email" autocomplete="email" placeholder="Email" />
    <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
    <div class="row">
      <button id="signin">Sign in</button>
      <button id="signup" class="secondary">Create account</button>
    </div>
  </section>

  <section id="request" class="stack">
    <p>Authorize this device?</p>
    <p><strong>Client:</strong> <span id="client"></span></p>
    <p><strong>Code:</strong> <code id="shown-code"></code></p>
    <p id="scope-row"><strong>Scope:</strong> <span id="scope"></span></p>
    <div id="decision" class="row">
      <button id="approve">Approve</button>
      <button id="deny" class="danger">Deny</button>
    </div>
  </section>

  <section id="done" class="stack">
    <p id="done-message"></p>
  </section>
  <p id="status"></p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (message) => { $("status").textContent = message || ""; };
  const codeInput = $("code");
  const initialCode = new URLSearchParams(location.search).get("user_code") || "";
  codeInput.value = initialCode;

  async function json(path, options = {}) {
    const response = await fetch(path, { credentials: "include", ...options });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      throw new Error(body?.error_description || body?.message || body?.error || "Request failed");
    }
    return body;
  }

  async function session() {
    try { return await json("/api/auth/get-session"); } catch { return null; }
  }

  async function inspect() {
    status("");
    const userCode = codeInput.value.trim().toUpperCase();
    if (!userCode) { status("Enter the code shown by the Dispatch CLI."); return; }
    codeInput.value = userCode;
    try {
      const signedIn = await session();
      if (!signedIn?.user) {
        $("account").style.display = "grid";
        $("request").style.display = "none";
        return;
      }
      const request = await json("/api/auth/device?user_code=" + encodeURIComponent(userCode));
      $("account").style.display = "none";
      $("request").style.display = "grid";
      $("client").textContent = request.client_id || "Dispatch CLI";
      $("shown-code").textContent = request.user_code || userCode;
      $("scope").textContent = request.scope || "account session";
      $("scope-row").style.display = request.scope ? "block" : "none";
      $("decision").style.display = request.status === "pending" ? "grid" : "none";
      if (request.status !== "pending") status("This device request is already " + request.status + ".");
    } catch (error) {
      status(error instanceof Error ? error.message : String(error));
    }
  }

  async function authenticate(mode) {
    status("");
    const email = $("email").value.trim();
    const password = $("password").value;
    if (!email || !password) { status("Enter your email and password."); return; }
    try {
      const path = mode === "signin" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email";
      const body = mode === "signin" ? { email, password } : { email, password, name: email };
      await json(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await inspect();
    } catch (error) {
      status(error instanceof Error ? error.message : String(error));
    }
  }

  async function decide(approved) {
    status("");
    const userCode = codeInput.value.trim().toUpperCase();
    try {
      await json(approved ? "/api/auth/device/approve" : "/api/auth/device/deny", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
      $("request").style.display = "none";
      $("done").style.display = "grid";
      $("done-message").textContent = approved
        ? "Approved. You can return to the Dispatch CLI."
        : "Denied. The Dispatch CLI will not be signed in.";
    } catch (error) {
      status(error instanceof Error ? error.message : String(error));
    }
  }

  $("check").addEventListener("click", inspect);
  $("signin").addEventListener("click", () => authenticate("signin"));
  $("signup").addEventListener("click", () => authenticate("signup"));
  $("approve").addEventListener("click", () => decide(true));
  $("deny").addEventListener("click", () => decide(false));
  if (initialCode) inspect();
})();
</script>
</body>
</html>`;
}
