const REAL_ORIGIN = "https://lanaria-studio.delaneycayzer.workers.dev";
const COOKIE_NAME = "lanaria_access";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function comingSoonPage(showError) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lanaria Studio &mdash; Coming Soon</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #F3EEE0;
    color: #3B4F35;
    font-family: Georgia, 'Times New Roman', serif;
    text-align: center;
    padding: 24px;
    box-sizing: border-box;
  }
  .wrap { max-width: 420px; }
  h1 {
    font-size: 2.25rem;
    letter-spacing: 0.04em;
    margin-bottom: 0.2em;
  }
  p.tag {
    font-style: italic;
    opacity: 0.75;
    margin-top: 0;
    margin-bottom: 2.5em;
    letter-spacing: 0.03em;
  }
  p.copy { margin-bottom: 2.5em; line-height: 1.5; }
  form {
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
  }
  input[type="password"] {
    font-family: inherit;
    padding: 10px 14px;
    border: 1px solid #3B4F35;
    background: transparent;
    color: #3B4F35;
    border-radius: 4px;
    font-size: 0.95rem;
    outline: none;
    min-width: 180px;
  }
  button {
    font-family: inherit;
    padding: 10px 18px;
    border: 1px solid #3B4F35;
    background: #3B4F35;
    color: #F3EEE0;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:hover { opacity: 0.9; }
  .error {
    color: #8a3b2b;
    font-size: 0.85rem;
    margin-top: 14px;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Lanaria Studio</h1>
    <p class="tag">Design. Print. Create.</p>
    <p class="copy">We're putting the finishing touches on something new. Check back soon.</p>
    <form method="POST" action="/">
      <input type="password" name="password" placeholder="Password" autocomplete="off" autofocus />
      <button type="submit">Enter</button>
    </form>
    ${showError ? `<div class="error">Incorrect password.</div>` : ""}
  </div>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!env.SITE_PASSWORD) {
      return new Response("Gate misconfigured: SITE_PASSWORD is not set.", { status: 500 });
    }

    const expectedHash = await sha256(env.SITE_PASSWORD);
    const cookieHeader = request.headers.get("Cookie") || "";
    const authed = cookieHeader.includes(`${COOKIE_NAME}=${expectedHash}`);

    // Handle password submission
    if (request.method === "POST" && url.pathname === "/") {
      const form = await request.formData();
      const submitted = form.get("password") || "";

      if (submitted === env.SITE_PASSWORD) {
        const headers = new Headers();
        headers.append(
          "Set-Cookie",
          `${COOKIE_NAME}=${expectedHash}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
        );
        headers.append("Location", "/");
        return new Response(null, { status: 302, headers });
      }

      return new Response(comingSoonPage(true), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }

    // Not authenticated: always show the coming-soon page
    if (!authed) {
      return new Response(comingSoonPage(false), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }

    // Authenticated: proxy through to the real app
    const originUrl = new URL(url.pathname + url.search, REAL_ORIGIN);
    const proxyRequest = new Request(originUrl.toString(), request);
    return fetch(proxyRequest);
  },
};
