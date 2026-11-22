import { describe, expect, it } from "vitest";
import { extractRequestFields } from "../../scripts/api-audit/php-fields.mjs";

// Trimmed from Firefly III v6.7.9, app/Api/V1/Requests/Models/Bill/StoreRequest.php.
const bill = `
class StoreRequest extends FormRequest
{
    public function getAll(): array
    {
        $fields = [
            'name'               => ['name', 'convertString'],
            'currency_code'      => ['currency_code', 'convertString'],
            'end_date'           => ['end_date', 'date'],
            'extension_date'     => ['extension_date', 'date'],
            'order'              => ['order', 'convertInteger'],
            'object_group_id'    => ['object_group_id', 'convertInteger'],
        ];

        return $this->getAllData($fields);
    }

    public function rules(): array
    {
        return [
            'name'           => ['min:1', 'max:255', 'uniqueObjectForUser:bills,name'],
            'currency_code'  => ['min:3', 'max:51', 'exists:transaction_currencies,code'],
            'end_date'       => ['nullable', 'date', 'after:date'],
        ];
    }
}`;

describe("extractRequestFields", () => {
  it("reads the request field from the value, not the internal key", () => {
    // Account's UpdateRequest maps the request field `type` to `account_type_name`.
    const php = `public function getUpdateData(): array
    {
        $fields = [
            'account_type_name' => ['type', 'convertString'],
            'cc_type'           => ['credit_card_type', 'convertString'],
        ];
        return $this->getAllData($fields);
    }`;
    expect(extractRequestFields(php).read).toEqual(["type", "credit_card_type"]);
  });

  it("separates the fields a class reads from the ones it validates", () => {
    const { read, validated } = extractRequestFields(bill);
    expect(read).toEqual(["name", "currency_code", "end_date", "extension_date", "order", "object_group_id"]);
    expect(validated).toEqual(["name", "currency_code", "end_date"]);
  });

  it("finds fields read through $this-> helper calls, in first-seen order without duplicates", () => {
    const php = `public function getAll(): array
    {
        if ($this->has('notes')) { $data['notes'] = $this->stringWithNewlines('notes'); }
        $data['name'] = $this->convertString('name');
        $data['apply_rules'] = $this->boolean('apply_rules', true);
        return $data;
    }`;
    expect(extractRequestFields(php).read).toEqual(["notes", "name", "apply_rules"]);
  });

  it("names fields read inside a loop over a request array as array.*.field", () => {
    const php = `public function getAll(): array
    {
        return ['transactions' => $this->getTransactionData()];
    }
    private function getTransactionData(): array
    {
        foreach ($this->get('transactions') as $transaction) {
            $object   = new NullArrayObject($transaction);
            $return[] = [
                'amount'      => $this->clearString((string) $object['amount']),
                'description' => $this->clearString($object['description']),
            ];
        }
        return $return;
    }
    private function getRuleTriggers(): array
    {
        $triggers = $this->get('triggers');
        foreach ($triggers as $trigger) {
            $return[] = ['prohibited' => $this->convertBoolean((string) ($trigger['prohibited'] ?? 'false'))];
        }
        return $return;
    }`;
    expect(extractRequestFields(php).read).toEqual([
      "transactions", "transactions.*.amount", "transactions.*.description", "triggers", "triggers.*.prohibited",
    ]);
  });

  it("finds fields read through a class's own helper", () => {
    // Rule/TriggerRequest reads start and end through a private getDate().
    const php = `public function getTriggerParameters(): array
    {
        return ['start' => $this->getDate('start'), 'end' => $this->getDate('end')];
    }`;
    expect(extractRequestFields(php).read).toEqual(["start", "end"]);
  });

  it("follows field-name lists into helpers that take the loop item as a parameter", () => {
    // Shape of Transaction/UpdateRequest: field names live in a property, a
    // helper indexes the split with each, and the loop that feeds the helper
    // comes later in the file.
    const php = `public function getAll(): array
    {
        $this->stringFields = ['description', 'source_name'];
        return ['transactions' => $this->getTransactionData()];
    }
    private function getStringData(array $current, array $transaction): array
    {
        foreach ($this->stringFields as $fieldName) {
            if (array_key_exists($fieldName, $transaction)) {
                $current[$fieldName] = $this->clearString((string) $transaction[$fieldName]);
            }
        }
        return $current;
    }
    private function getTransactionData(): array
    {
        $transactions = $this->get('transactions');
        foreach ($transactions as $transaction) {
            $current = $this->getStringData([], $transaction);
        }
        return [];
    }`;
    expect(extractRequestFields(php).read).toEqual(expect.arrayContaining(["transactions.*.description", "transactions.*.source_name"]));
  });

  it("keeps nested validation keys as written", () => {
    const php = `public function rules(): array
    {
        return ['transactions.*.amount' => 'required', 'group_title' => 'min:1'];
    }`;
    expect(extractRequestFields(php).validated).toEqual(["transactions.*.amount", "group_title"]);
  });

  it("ignores fields mentioned only in withValidator", () => {
    const php = `public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $data = $validator->getData();
            if ($this->has('secret')) { return; }
        });
    }`;
    expect(extractRequestFields(php)).toEqual({ read: [], validated: [] });
  });
});
