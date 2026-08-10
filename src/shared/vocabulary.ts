/**
 * Built-in tech proper-noun vocabulary for dictation.
 *
 * Speech models split and lowercase brand names — "open ai", "get hub", "type
 * script". These rules fix them deterministically, and are fed into the same
 * post-recognition dictionary pass (src/main/dictionary.ts) that user corrections
 * use, so they apply to BOTH the local (Parakeet) and OpenAI lanes and a user can
 * override any of them with their own rule.
 *
 * Conservative on purpose. Two safe kinds of fix only:
 *   1. SPLIT forms → the joined brand ("open ai" → "OpenAI"). The split form is
 *      unambiguous; nobody means two words.
 *   2. DISTINCTIVE single words → their canonical casing ("kubernetes" →
 *      "Kubernetes"). Only words that aren't ordinary English — so we never
 *      capitalize "go", "react", "rust", "stripe", "notion" mid-sentence.
 *
 * Casing follows the transcript style: in 'casual' the canonical is lowercased
 * ("openai", "github"), because casual is "typed in a chat window" where brands go
 * lower. The join is kept in both styles — "open ai" is wrong either way.
 */

export interface VocabTerm {
  /** The correct spelling to emit (as-spoken casing). */
  canonical: string
  /** Case-insensitive whole-word forms the recogniser tends to produce instead. */
  variants: string[]
}

export const DEFAULT_VOCAB: VocabTerm[] = [
  // Split-word brands (safe: the split form is never meant literally).
  { canonical: 'OpenAI', variants: ['open ai', 'open a i'] },
  { canonical: 'ChatGPT', variants: ['chat gpt', 'chat g p t'] },
  { canonical: 'GitHub', variants: ['git hub', 'get hub'] },
  { canonical: 'GitLab', variants: ['git lab'] },
  { canonical: 'TypeScript', variants: ['type script'] },
  { canonical: 'JavaScript', variants: ['java script'] },
  { canonical: 'Node.js', variants: ['node js', 'node dot js'] },
  { canonical: 'Next.js', variants: ['next js', 'next dot js'] },
  { canonical: 'VS Code', variants: ['vs code', 'v s code', 'vscode'] },
  { canonical: 'GraphQL', variants: ['graph ql', 'graph q l'] },
  { canonical: 'OAuth', variants: ['o auth'] },
  { canonical: 'WebSocket', variants: ['web socket'] },
  { canonical: 'PostgreSQL', variants: ['postgres ql', 'postgres q l', 'postgres sql'] },
  { canonical: 'MySQL', variants: ['my sql', 'my s q l'] },
  { canonical: 'kubectl', variants: ['kube control', 'cube control', 'kube cuddle'] },
  { canonical: 'localhost', variants: ['local host'] },

  // Distinctive single words → canonical casing (not ordinary English words).
  { canonical: 'Claude', variants: ['claude'] },
  { canonical: 'Anthropic', variants: ['anthropic'] },
  { canonical: 'Gemini', variants: ['gemini'] },
  { canonical: 'Kubernetes', variants: ['kubernetes', 'cuber netes', 'kubernettes'] },
  { canonical: 'Postgres', variants: ['postgres'] },
  { canonical: 'SQLite', variants: ['sqlite', 'sequel lite'] },
  { canonical: 'MongoDB', variants: ['mongodb', 'mongo db'] },
  { canonical: 'Redis', variants: ['redis'] },
  { canonical: 'Nginx', variants: ['nginx', 'engine x'] },
  { canonical: 'Docker', variants: ['docker'] },
  { canonical: 'Terraform', variants: ['terraform'] },
  { canonical: 'Kafka', variants: ['kafka'] },
  { canonical: 'Grafana', variants: ['grafana'] },
  { canonical: 'Prometheus', variants: ['prometheus'] },
  { canonical: 'Datadog', variants: ['datadog', 'data dog'] },
  { canonical: 'Sentry', variants: ['sentry'] },
  { canonical: 'Twilio', variants: ['twilio'] },
  { canonical: 'Vercel', variants: ['vercel', 'ver cell'] },
  { canonical: 'Netlify', variants: ['netlify'] },
  { canonical: 'Cloudflare', variants: ['cloudflare', 'cloud flare'] },
  { canonical: 'Supabase', variants: ['supabase', 'super base'] },
  { canonical: 'Figma', variants: ['figma'] },
  { canonical: 'Tailwind', variants: ['tailwind', 'tail wind'] },
  { canonical: 'Electron', variants: ['electron'] },

  // Acronyms the recogniser fumbles as words or spaced letters.
  { canonical: 'CLI', variants: ['clyde', 'c l i'] },
  { canonical: 'MCP', variants: ['m cp', 'mcb', 'm c p'] },
  // 'jason' is intentionally omitted — it's a common name and would clobber it.
  { canonical: 'JSON', variants: ['j son', 'j s o n'] },
  { canonical: 'LLM', variants: ['l m', 'lm', 'l l m'] }
]

/** A single post-recognition substitution: `from` (heard) → `to` (written). */
export interface VocabRule {
  from: string
  to: string
}

/**
 * Flatten the vocabulary into dictionary rules for the given output style.
 *
 * `casual` lowercases the canonical so brands read the way people type them in
 * chat ("openai", "github"); every other style keeps the proper casing. The join
 * survives either way. A rule whose `from` already equals its `to` (a distinctive
 * word in casual, e.g. "kubernetes") is dropped — it would be a no-op.
 */
export function vocabularyRules(style: 'as-spoken' | 'casual' = 'as-spoken'): VocabRule[] {
  const rules: VocabRule[] = []
  for (const { canonical, variants } of DEFAULT_VOCAB) {
    const to = style === 'casual' ? canonical.toLowerCase() : canonical
    for (const from of variants) {
      if (from.toLowerCase() === to.toLowerCase() && from === to) continue
      rules.push({ from, to })
    }
  }
  return rules
}
