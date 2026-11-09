import { SelectField } from "@/components/form";
import { formatNaira } from "@/lib/money";

export function MoneySourceField({
  sources,
}: {
  sources: { id: string; name: string; availableKobo: number }[];
}) {
  return (
    <SelectField name="source" label="Where the money came from" defaultValue="">
      <option value="" disabled>Choose…</option>
      {sources.map((person) => (
        <option key={person.id} value={person.id}>
          Cash held by {person.name} ({formatNaira(person.availableKobo)} today)
        </option>
      ))}
      <option value="bank">Bank</option>
      <option value="owner">Owner&apos;s own money</option>
    </SelectField>
  );
}
