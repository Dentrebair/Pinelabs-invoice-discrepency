// Verifies the Supabase foundation and prints the SR-001 case UUID.
// Usage: node --env-file=.env.local scripts/check-setup.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
let ok = true;

for (const table of ["suppliers", "cases", "documents", "discrepancies", "case_events"]) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) {
    ok = false;
    console.log(`✗ table ${table}: ${error.message}`);
  } else {
    console.log(`✓ table ${table} (${count} rows)`);
  }
}

const { data: bucket, error: bucketErr } = await db.storage.getBucket("supplier-docs");
if (bucketErr || !bucket) {
  ok = false;
  console.log(`✗ bucket supplier-docs: ${bucketErr?.message ?? "missing"}`);
} else if (bucket.public) {
  ok = false;
  console.log("✗ bucket supplier-docs is PUBLIC — must be private");
} else {
  console.log("✓ bucket supplier-docs is private");
}

const { data: cases, error: caseErr } = await db.from("cases").select("id, case_code, status").eq("case_code", "SR-001");
if (caseErr || cases.length !== 1) {
  ok = false;
  console.log(`✗ SR-001: expected exactly 1 case, found ${cases?.length ?? 0}`);
} else {
  console.log(`✓ SR-001 caseId = ${cases[0].id} (status ${cases[0].status})`);
}

process.exit(ok ? 0 : 1);
