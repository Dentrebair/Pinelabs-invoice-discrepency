# Backend API — Supplier Resolution Agent

Local, single trusted-user demo only. Do not deploy these routes publicly without
authentication, company scoping and RLS policies.

## Setup

```bash
cp .env.example .env.local   # fill NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run check-setup          # verifies tables, private bucket, prints SR-001 caseId
npm run dev
npm run smoke                # end-to-end acceptance checks (needs dev server)
```

`AI_MODE=mock` (default) returns a fixed SR-001 fixture whose text fields start with
`[MOCK AI RESULT …]`. It is for endpoint testing only, not a live analysis.

## For Dev 1 (UI)

Base path: `/api`. All errors are JSON `{ "error": string, "code": string }`.
Use `caseId` (UUID) everywhere; `caseCode` (`SR-001`) is for display only.

| Route | Request | Success |
|---|---|---|
| `POST /api/analyze` | multipart: `po`, `invoice`, `grn` (PDF files), optional `caseId` (UUID; omitted → seeded SR-001) | `AnalyzeResponse` |
| `POST /api/revalidate` | multipart: `caseId` (UUID), `revisedInvoice` (PDF file) | `RevalidateResponse` |
| `GET /api/cases/{caseId}` | — | `{ case, documents, discrepancies, events }` |

Sample `AnalyzeResponse` (mock mode):

```json
{
  "caseId": "<uuid>",
  "caseCode": "SR-001",
  "status": "DISCREPANCY_FOUND",
  "discrepancies": [{
    "id": "<uuid>",
    "issueType": "QUANTITY",
    "lineRef": "CTN-STD",
    "orderedQty": 100, "invoicedQty": 100, "receivedQty": 80,
    "poUnitPricePaise": 50000, "invoiceUnitPricePaise": 50000,
    "amountUnderReviewPaise": 1000000,
    "description": "…",
    "recommendedAction": "Request a revised invoice for 80 cartons.",
    "evidenceRefs": [{ "docType": "GRN", "documentId": "<uuid>", "documentNumber": "GRN-1001", "field": "receivedQty", "value": "80" }],
    "status": "OPEN"
  }],
  "investigationSummary": "…",
  "supplierMessageDraft": "…"
}
```

`GET /api/cases/{id}` returns document metadata (`documentId, docType, version,
documentNumber, originalFilename, extractionStatus, extractionError, uploadedAt,
extractedJson`) — never storage paths or file bytes. Events are
`{ eventId, eventType, actorType, note, payload, createdAt }`.

### Error codes

| HTTP | code |
|---|---|
| 400 | `INVALID_CONTENT_TYPE`, `INVALID_FORM`, `MISSING_FILE`, `INVALID_FILE`, `EMPTY_FILE`, `INVALID_FILE_TYPE`, `INVALID_PDF`, `MISSING_CASE_ID`, `INVALID_CASE_ID` |
| 404 | `CASE_NOT_FOUND` |
| 409 | `CASE_NOT_READY` (revalidate before analyze), `VERSION_CONFLICT` |
| 413 | `FILE_TOO_LARGE` (>10 MB per file), `PAYLOAD_TOO_LARGE` |
| 422 | `AI_INVALID_OUTPUT` — case set to `NEEDS_REVIEW` |
| 503 | `AI_NOT_CONFIGURED` — `AI_MODE=live` before Dev 2 wiring |
| 504 | `AI_TIMEOUT` — case set to `NEEDS_REVIEW` |
| 500 | `STORAGE_ERROR`, `DB_ERROR`, `INTERNAL_ERROR` — case set to `ERROR` |

Every failure after the case is resolved writes an `ERROR` case event.

## For Dev 2 (AI)

The single seam is `src/lib/server/ai.ts`. Replace `liveAnalyze` / `liveRevalidate`
with your exports, then set `AI_MODE=live`. Outputs are validated with Zod; anything
that fails becomes `422 AI_INVALID_OUTPUT` and the case goes to `NEEDS_REVIEW`.

```ts
analyzeDocuments({ poPdf, invoicePdf, grnPdf }: { [k]: Buffer })
  -> {
    extractedDocuments: { PO, INVOICE, GRN },   // each { docType, documentNumber?, lineItems?: [{ lineRef, ... }], ...any }
    discrepancies: Discrepancy[],               // from src/lib/contracts.ts; integer paise
    investigationSummary: string,
    supplierMessageDraft: string,
  }

revalidateInvoice({ originalDocuments: { PO, INVOICE, GRN }, revisedInvoicePdf: Buffer })
  -> { extractedRevisedInvoice, discrepancies: Discrepancy[], explanation: string, status: CaseStatus }
```

- `evidenceRefs[].docType` must be a document on the case (`PO`, `INVOICE`, `GRN`,
  plus `REVISED_INVOICE` on revalidate). The backend fills `documentId`.
- `originalDocuments` is the `extracted_json` you returned at analysis time.
- Revalidation status is guarded: `READY_FOR_PAYMENT_APPROVAL` is only accepted if
  every returned discrepancy is `RESOLVED`; otherwise it becomes `NEEDS_REVIEW`.
  It is a case status, not a payment approval or payout.

## Persistence behaviour

- PDFs go to private bucket `supplier-docs` at `caseId/docType/vN-<uuid>.pdf`;
  the version is the next integer per (case, docType). Originals are never overwritten.
- The revised invoice is stored as `REVISED_INVOICE`; the original `INVOICE` row stays.
- Re-running analyze replaces the case's discrepancy rows; history stays in `case_events`.
- On a successful revalidation, `OPEN` discrepancies become `RESOLVED`; otherwise
  unresolved rows are replaced by the latest findings.

## curl

```bash
F=fixtures/sr-001
curl -s -F po=@$F/PO-1001.pdf\;type=application/pdf \
        -F invoice=@$F/INV-1001.pdf\;type=application/pdf \
        -F grn=@$F/GRN-1001.pdf\;type=application/pdf \
        localhost:3000/api/analyze | jq

curl -s -F caseId=<uuid> -F revisedInvoice=@$F/INV-1001-R1.pdf\;type=application/pdf \
        localhost:3000/api/revalidate | jq

curl -s localhost:3000/api/cases/<uuid> | jq
```
