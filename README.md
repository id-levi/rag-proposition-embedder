# rag-proposition-embedder

AWS Lambda function for ingesting documents into a RAG memory system via atomic proposition extraction and bilingual vector embeddings.

Part of the [HKSoka](https://hksoka.com/en) production LLM platform.

---

## What it does

1. Receives document chunks from upstream
2. Extracts atomic propositions from each chunk via Claude Haiku
3. Generates bilingual embeddings (Gemini) combining original text + English translation into a single vector
4. Upserts into pgvector with exclusion-gate support

---

## Design decisions

### Proposition extraction over fixed-size chunking

Fixed-size chunking splits text at arbitrary boundaries. A chunk may contain half a sentence, a table header with no data, or two unrelated facts merged together. Each of these degrades retrieval precision.

Proposition extraction rewrites the source into discrete, self-contained factual statements before embedding. Each vector represents exactly one idea. At retrieval time, the query matches the right fact rather than the right paragraph — which matters for conversational memory where queries are often specific and short.

### Translation embedded alongside source text

The embedding input is `[Section] <original proposition> <English translation>` as a single string.

The system handles Cantonese, Mandarin, and English input. A user writing in English may ask about content originally ingested in Chinese, and vice versa. Embedding the translation alongside the source within the same vector preserves cross-lingual alignment in the embedding space — without needing a separate cross-lingual retrieval step or query-time translation.

### Regex recovery on JSON parse failure

LLM output is not guaranteed to be valid JSON. Claude Haiku may return well-formed propositions embedded in malformed JSON — truncated arrays, trailing commas, code fences not fully stripped.

When `JSON.parse` fails, the handler falls back to regex extraction of individual `{...}` objects that contain `"section"` and `"proposition"` keys. Recoverable propositions are extracted and embedded; the failure is logged with `[PROP_PARTIAL]`. This avoids discarding an entire segment because the last few tokens of a long JSON array were malformed.

### ON CONFLICT upsert with exclusion-gate preservation

The insert uses `ON CONFLICT (user_id, content)` to deduplicate. The update clause deliberately preserves `is_exclusion = TRUE` if it was already set — re-ingesting a document does not accidentally un-delete a fact the user has marked for exclusion.

---

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (pgvector-enabled) |
| `ANTHROPIC_API_KEY` | Claude Haiku access |
| `GEMINI_API_KEY` | Gemini Embedding API access |

---

## Stack

- Runtime: Node.js (ESM)
- Extraction model: `claude-haiku-4-5-20251001`
- Embedding model: `gemini-embedding-001` (1536 dimensions)
- Database: PostgreSQL + pgvector
- Deployment: AWS Lambda
