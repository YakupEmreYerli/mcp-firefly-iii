/** The two browser screens of the embedded authorization server.
 *
 * Plain server-rendered HTML with no external assets: the pages have to work
 * inside a client's popup window, which may block anything cross-origin. */

const STYLE = `
body{font:16px system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1rem;color:#17202a;background:#f7f8fa}
main{background:white;padding:2rem;border-radius:12px;box-shadow:0 2px 12px #0001}
label{display:block;margin:1rem 0 .35rem}
input,button{font:inherit;padding:.65rem;width:100%;box-sizing:border-box}
button{margin-top:1.5rem;background:#1769aa;color:white;border:0;border-radius:6px;cursor:pointer}
.scope{display:flex;gap:.6rem;align-items:center}
.scope input{width:auto}
`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>${STYLE}</style></head>` +
  `<body><main>${body}</main></body></html>`;

const SCOPE_LABELS: Record<string, string> = {
  "firefly:read": "Read Firefly data",
  "firefly:write": "Create and update data",
  "firefly:destructive": "Delete or bulk-change data",
};

export function loginPage(formToken: string, error?: string): string {
  const message = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  return page(
    "Firefly authorization",
    `${message}<h1>Connect to Firefly III</h1>` +
      `<form method="post">` +
      `<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">` +
      `<label for="password">Password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required>` +
      `<button type="submit">Continue</button></form>`,
  );
}

/** `scopes` is everything on offer; `requested` is what the client asked for,
 * and only those boxes start ticked. Anything else is there to be added by the
 * person reading the screen, who is the only one who can widen a grant. */
export function consentPage(
  formToken: string,
  scopes: string[],
  requested: string[] = scopes,
  error?: string,
): string {
  const message = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  const wanted = new Set(requested);
  const choices = scopes
    .map(
      (scope) =>
        `<label class="scope">` +
        `<input type="checkbox" name="scope" value="${escapeHtml(scope)}"${wanted.has(scope) ? " checked" : ""}> ` +
        `${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</label>`,
    )
    .join("");
  return page(
    "Approve Firefly access",
    `${message}<h1>Approve access</h1>` +
      `<p>Tick everything this client may do. It asked for the boxes already ticked; ` +
      `adding one grants more than it requested, and unticking one grants less.</p>` +
      `<form method="post">` +
      `<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">` +
      `${choices}<button type="submit">Approve</button></form>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}
