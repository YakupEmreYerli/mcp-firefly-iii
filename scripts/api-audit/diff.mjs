// Maintainer tool, not part of the published package.
//
// Maps a write endpoint to the Firefly III request class that reads its body,
// and diffs the fields we send against the fields that class reads.

// Path segment → folder under app/Api/V1/Requests/Models (checked against v6.7.9).
const FOLDERS = {
  accounts: "Account",
  attachments: "Attachment",
  bills: "Bill",
  budgets: "Budget",
  categories: "Category",
  currencies: "TransactionCurrency",
  "exchange-rates": "CurrencyExchangeRate",
  "piggy-banks": "PiggyBank",
  recurrences: "Recurrence",
  "rule-groups": "RuleGroup",
  rules: "Rule",
  tags: "Tag",
  "transaction-links": "TransactionLink",
  transactions: "Transaction",
};

const ROUTES = [
  { method: "POST", path: /^\/budgets\/\{id\}\/limits$/, file: () => "Models/BudgetLimit/StoreRequest.php" },
  { method: "PUT", path: /^\/budgets\/\{id\}\/limits\/\{id\}$/, file: () => "Models/BudgetLimit/UpdateRequest.php" },
  { method: "POST", path: /^\/(rules|rule-groups)\/\{id\}\/trigger$/, file: (m) => `Models/${FOLDERS[m[1]]}/TriggerRequest.php` },
  { method: "POST", path: /^\/([a-z-]+)$/, file: (m) => FOLDERS[m[1]] && `Models/${FOLDERS[m[1]]}/StoreRequest.php` },
  { method: "PUT", path: /^\/([a-z-]+)\/\{id\}$/, file: (m) => FOLDERS[m[1]] && `Models/${FOLDERS[m[1]]}/UpdateRequest.php` },
];

/**
 * @param {string} method
 * @param {string} path templated, ids as {id}
 * @returns {string | undefined} class path relative to app/Api/V1/Requests
 */
export function requestClassFor(method, path) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.path.exec(path);
    if (match) return route.file(match) || undefined;
  }
  return undefined;
}

/**
 * @param {string[]} ours keys we send
 * @param {{ read: string[], validated: string[] }} theirs
 * @returns {{ missing: string[], ignored: string[] }}
 */
export function diffFields(ours, theirs) {
  return {
    missing: theirs.read.filter((key) => !ours.includes(key)),
    ignored: ours.filter((key) => !theirs.read.includes(key)),
  };
}
