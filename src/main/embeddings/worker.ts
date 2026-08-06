/**
 * Embedding worker (utilityProcess) — placeholder until the semantic-search milestone.
 * Will host the local embedding model (EmbeddingGemma via transformers.js) so tokenizing
 * and inference never block the main process.
 */
process.parentPort?.on('message', (e) => {
  if (e.data?.type === 'ping') process.parentPort.postMessage({ type: 'pong' })
})
