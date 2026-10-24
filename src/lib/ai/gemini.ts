import "server-only";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

// Thrown when the model's output cannot be trusted (bad JSON, schema mismatch,
// unparseable values). The backend maps this to NEEDS_REVIEW.
export class AiOutputError extends Error {
  name = "AiOutputError";
}

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  client = new GoogleGenAI({ apiKey });
  return client;
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export const pdfPart = (pdf: Buffer): Part => ({
  inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") },
});

// One structured-output call: Gemini is constrained to the schema's JSON
// Schema, and the reply is re-validated with zod before use.
export async function generateJson<T>(schema: z.ZodType<T>, prompt: string, parts: Part[] = []): Promise<T> {
  const res = await gemini().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [...parts, { text: prompt }] }],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(schema, { target: "draft-7" }),
    },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(res.text ?? "");
  } catch {
    throw new AiOutputError("Model did not return JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AiOutputError(`Model JSON failed validation at ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}
