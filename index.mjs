import pg from 'pg';
const { Client } = pg;

export const handler = async (event) => {
  let { userId, chunks, fullContent } = JSON.parse(event.body ?? '{}');

  if (!userId || !chunks?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or chunks' }) };
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const expandedChunks = [];
  for (const chunk of chunks) {
    if (chunk.content.length <= 300) {
      expandedChunks.push(chunk);
      continue;
    }

    const SEGMENT_SIZE = 3000;
    const segments = [];
    for (let s = 0; s < chunk.content.length; s += SEGMENT_SIZE) {
      segments.push(chunk.content.slice(s, s + SEGMENT_SIZE));
    }

    for (const segment of segments) {
      const propRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16000,
          messages: [{
            role: 'user',
            content: `Extract all atomic propositions from this text. For each proposition, identify which section or topic it belongs to. Preserve the original language exactly — do not translate. If the source text is in Chinese or mixed Chinese-English, your output propositions MUST be in the same language as the source. Never output English if the source is Chinese. Each proposition must be self-contained — if a bullet point requires context to understand, include that context in the proposition itself.
Return ONLY a JSON array of objects, no other text.
Example: [{"section": "Section Name", "proposition": "原文命題（保留原語言）", "translation": "English translation of the proposition"}]
Text:
${segment}`
          }]
        })
      });

      const propData = await propRes.json();
      if (!propRes.ok) {
        console.error('[PROP_FAIL] http=' + propRes.status + ' seg_len=' + segment.length + ' ' + JSON.stringify(propData).slice(0, 300));
        continue;
      }

      const rawText = propData.content?.[0]?.text ?? '[]';
      if (!propData.content?.[0]?.text) {
        console.error('[PROP_EMPTY] no text block returned ' + JSON.stringify(propData).slice(0, 300));
      }

      const cleaned = rawText.replace(/```json\n?|\n?```/g, '').trim();

      let propositions;
      try {
        propositions = JSON.parse(cleaned);
        if (!Array.isArray(propositions)) throw new Error('not array');
      } catch (e) {
        console.error('[PROP_PARSE] ' + e.message);
        const partial = cleaned.match(/\{[^{}]*"section"[^{}]*"proposition"[^{}]*\}/g) ?? [];
        console.error('[PROP_PARTIAL] recovered ' + partial.length + ' of an unparseable response');
        for (const item of partial) {
          try {
            const obj = JSON.parse(item);
            if (obj.proposition?.trim().length > 10) {
              const embeddingText = obj.section ? `[${obj.section}] ${obj.proposition.trim()}` : obj.proposition.trim();
              expandedChunks.push({ content: obj.proposition.trim(), embeddingText, category: chunk.category, seedId: chunk.seedId, factId: chunk.factId ?? null, isExclusion: chunk.isExclusion ?? false });
            }
          } catch {}
        }
        continue;
      }

      for (const prop of propositions) {
        if (!prop.proposition || prop.proposition.trim().length <= 10) continue;
        const embeddingText = [
          prop.section ? `[${prop.section}]` : '',
          prop.proposition.trim(),
          prop.translation ? prop.translation.trim() : ''
        ].filter(Boolean).join(' ');
        expandedChunks.push({
          content: prop.proposition.trim(),
          embeddingText,
          category: chunk.category,
          seedId: chunk.seedId,
          factId: chunk.factId ?? null,
          isExclusion: chunk.isExclusion ?? false
        });
      }
    } // end segment loop
  } // end chunk loop

  let globalIndex = 0;
  let embedded = 0;
  let skipped = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < expandedChunks.length; i += BATCH_SIZE) {
    const batch = expandedChunks.slice(i, i + BATCH_SIZE);
    const batchWithIndex = batch.map((chunk) => ({ ...chunk, index: globalIndex++ }));

    await Promise.all(batchWithIndex.map(async (chunk) => {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: { parts: [{ text: chunk.embeddingText ?? chunk.content }] },
              outputDimensionality: 1536,
            }),
          }
        );
        const data = await res.json();
        const embedding = data.embedding?.values;
        if (!embedding) {
          skipped++;
          console.error('[EMBED_SKIP] http=' + res.status + ' content="' + String(chunk.content).slice(0, 60) + '" ' + JSON.stringify(data).slice(0, 200));
          return;
        }

        const isExcl = chunk.isExclusion === true;
        await client.query(
          'INSERT INTO memory_embeddings (user_id, content, category, embedding, seed_id, chunk_index, fact_id, is_exclusion) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8) ON CONFLICT (user_id, content) DO UPDATE SET fact_id = CASE WHEN memory_embeddings.fact_id IS NULL THEN EXCLUDED.fact_id ELSE memory_embeddings.fact_id END, is_exclusion = memory_embeddings.is_exclusion OR EXCLUDED.is_exclusion',
          [userId, chunk.content, chunk.category ?? 'general', JSON.stringify(embedding), chunk.seedId ?? null, chunk.index, chunk.factId ?? null, isExcl]
        );
        embedded++;
      } catch (err) {
        skipped++;
        console.error('[CHUNK_ERR] ' + err.message);
      }
    }));

    if (i + BATCH_SIZE < expandedChunks.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log('[EMBED_SUMMARY] expanded=' + expandedChunks.length + ' embedded=' + embedded + ' skipped=' + skipped);

  await client.end();
  return { statusCode: 200, body: JSON.stringify({ ok: true, expanded: expandedChunks.length, embedded, skipped }) };
};
