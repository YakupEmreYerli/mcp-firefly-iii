/** The one browser screen of the embedded authorization server.
 *
 * Plain server-rendered HTML with no external assets: it has to work inside a
 * client's popup window, which may block anything cross-origin. */

const STYLE = `
body{font:16px system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1rem;color:#17202a;background:#f7f8fa}
main{background:white;padding:2rem;border-radius:12px;box-shadow:0 2px 12px #0001}
label{display:block;margin:1rem 0 .35rem}
input,button{font:inherit;padding:.65rem;width:100%;box-sizing:border-box}
button{margin-top:1.5rem;background:#1769aa;color:white;border:0;border-radius:6px;cursor:pointer}
p{color:#4a5568}
`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>${STYLE}</style></head>` +
  `<body><main>${body}</main></body></html>`;

export function loginPage(formToken: string, error?: string): string {
  const message = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  return page(
    "Firefly authorization",
    `${message}<h1>Connect to Firefly III</h1>` +
      `<p>The password grants this client full access: reading, creating and ` +
      `updating records, and deleting them.</p>` +
      `<form method="post">` +
      `<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">` +
      `<label for="password">Password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required>` +
      `<button type="submit">Continue</button></form>`,
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
