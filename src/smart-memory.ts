import { createHash } from "node:crypto";
import type { AtomService } from "./atom-service.js";
import type { Config } from "./config.js";
import { logger, metrics } from "./telemetry.js";
import type { AtomCreateInput, AtomKind, SearchResult } from "./types.js";
import { normalizeContent, normalizeNamespace, normalizeTags } from "./utils.js";

type SmartMode = "off" | "auto" | "on";
type DecisionAction = "create" | "skip" | "supersede" | "resolve" | "deprecate";

interface PlannedAtom {
  content: string;
  kind: AtomKind;
  importance: number;
  action: DecisionAction;
  targetAtomId?: string | null;
}

interface SmartDecision {
  atoms: PlannedAtom[];
}

interface CacheEntry {
  expiresAt: number;
  value: SmartDecision;
}

export interface SmartMemoryStats {
  enabled: boolean;
  mode: SmartMode;
  model: string;
  calls: number;
  cacheHits: number;
  avoidedDeterministic: number;
  avoidedReadPath: number;
  avoidedBudget: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  dailyCalls: number;
  dailyEstimatedInputTokens: number;
  dailyCallBudget: number;
  dailyInputTokenBudget: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function classify(content: string): { kind: AtomKind; importance: number } {
  const text = content.toLocaleLowerCase("und");
  if (/\b(prefer|preference|likes?|dislikes?|favorite|favourite)\b|선호|좋아하|싫어하|원함|원한다/.test(text)) return { kind: "preference", importance: 0.7 };
  if (/\b(todo|task|need to|must|should|remind)\b|해야 ?함|해야 ?해|할 ?일|리마인드|기한/.test(text)) return { kind: "task", importance: 0.65 };
  if (/\b(step|procedure|how to|workflow)\b|절차|방법|순서|워크플로/.test(text)) return { kind: "procedure", importance: 0.6 };
  if (/\b(decided|decision|agreed)\b|결정|합의/.test(text)) return { kind: "fact", importance: 0.75 };
  if (/\b(observed|noticed|seems)\b|관찰|발견|보인다|같다/.test(text)) return { kind: "observation", importance: 0.5 };
  if (/\b(meeting|event|appointment|on 20\d\d[-/.])\b|회의|행사|약속/.test(text)) return { kind: "event", importance: 0.6 };
  return { kind: "fact", importance: 0.5 };
}

function obviousSplit(raw: string): string[] {
  const text = normalizeContent(raw);
  if (!text) return [];
  const lines = text.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= 8 && lines.every(line => line.length >= 8)) return lines;

  if (text.length >= 260) {
    const sentences = text.split(/(?<=[.!?。！？])\s+/).map(value => value.trim()).filter(value => value.length >= 8);
    if (sentences.length >= 2 && sentences.length <= 8) return sentences;
  }
  return [text];
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeContent(text).toLocaleLowerCase("und").split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1));
}

function overlap(a: string, b: string): number {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

function looksLikeLifecycleUpdate(raw: string): boolean {
  const text = normalizeContent(raw).toLocaleLowerCase("und");
  return /\b(fixed|resolved|solved|completed|done|repaired|obsolete|deprecated|retired|no longer)\b|해결(?:됐|됨|했|완료)|고쳤|고쳐졌|수정(?:됐|됨|완료)|완료(?:됐|됨|했)|끝났|끝남|더 이상.{0,20}(?:아니|없)|폐기(?:됐|됨|했)|사용 중단|구식|무효/.test(text);
}

function extractResponseText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content) {
        if (typeof content?.text === "string") return content.text;
        if (typeof content?.json === "object") return JSON.stringify(content.json);
      }
    }
  }
  return "";
}

function parseDecision(raw: string, fallbackContent: string): SmartDecision {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Smart model returned no JSON object");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed?.atoms)) throw new Error("Smart model JSON is missing atoms");
  const atoms: PlannedAtom[] = parsed.atoms.slice(0, 8).map((item: any) => {
    const content = normalizeContent(String(item?.content ?? ""));
    if (!content || content.length > 100_000) throw new Error("Smart model returned invalid atom content");
    const allowedKinds = new Set<AtomKind>(["fact", "preference", "person", "event", "task", "note", "procedure", "concept", "observation"]);
    const action: DecisionAction = ["create", "skip", "supersede", "resolve", "deprecate"].includes(item?.action) ? item.action : "create";
    return {
      content,
      kind: allowedKinds.has(item?.kind) ? item.kind : classify(content).kind,
      importance: clamp01(Number.isFinite(item?.importance) ? Number(item.importance) : classify(content).importance),
      action,
      targetAtomId: typeof item?.targetAtomId === "string" ? item.targetAtomId : null
    };
  });
  if (!atoms.length) return { atoms: [{ ...classify(fallbackContent), content: normalizeContent(fallbackContent), action: "create" }] };
  return { atoms };
}

export class SmartMemoryService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly counters = {
    calls: 0,
    cacheHits: 0,
    avoidedDeterministic: 0,
    avoidedReadPath: 0,
    avoidedBudget: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0
  };
  private budgetDay = "";
  private dailyCalls = 0;
  private dailyEstimatedInputTokens = 0;

  constructor(private readonly config: Config, private readonly atoms: AtomService) {}

  stats(): SmartMemoryStats {
    return {
      enabled: this.isEnabled(),
      mode: this.config.smartModelEnabled,
      model: this.config.smartModel,
      ...this.counters,
      dailyCalls: this.dailyCalls,
      dailyEstimatedInputTokens: this.dailyEstimatedInputTokens,
      dailyCallBudget: this.config.smartModelDailyCallBudget,
      dailyInputTokenBudget: this.config.smartModelDailyInputTokenBudget
    };
  }

  async recall(input: { query: string; namespace?: string; limit?: number; maxCharacters?: number; maxTokens?: number }): Promise<Record<string, unknown>> {
    this.counters.avoidedReadPath += 1;
    metrics.increment("smart_model_avoided_read_total");
    return this.atoms.context({
      query: input.query,
      namespace: input.namespace,
      limit: Math.max(1, Math.min(input.limit ?? 8, 50)),
      maxCharacters: input.maxCharacters ?? 8_000,
      maxTokens: input.maxTokens ?? 2_000,
      mode: "hybrid"
    });
  }

  async remember(input: {
    text: string;
    namespace?: string;
    tags?: string[];
    source?: Record<string, unknown>;
    store?: boolean;
  }): Promise<Record<string, unknown>> {
    const text = normalizeContent(input.text);
    if (!text) throw new Error("text must not be empty");
    if (text.length > 100_000) throw new Error("text exceeds 100000 characters");
    const namespace = normalizeNamespace(input.namespace ?? "default");
    const pieces = obviousSplit(text);
    const candidates = await this.lexicalCandidates(text, namespace);
    const lifecycleHint = looksLikeLifecycleUpdate(text);
    const strongDuplicate = candidates.find(candidate => candidate.lexical_score >= this.config.smartModelDuplicateLexicalThreshold && overlap(text, candidate.content) >= 0.9);

    let decision: SmartDecision;
    let path: "deterministic" | "cache" | "model";
    if (strongDuplicate && pieces.length === 1 && !lifecycleHint) {
      decision = { atoms: [{ content: text, ...classify(text), action: "skip", targetAtomId: strongDuplicate.id }] };
      path = "deterministic";
      this.avoidDeterministic();
    } else if (!this.shouldUseModel(text, pieces, candidates, lifecycleHint)) {
      decision = { atoms: pieces.map(content => ({ content, ...classify(content), action: "create" as const })) };
      path = "deterministic";
      this.avoidDeterministic();
    } else {
      const key = this.cacheKey(text, namespace, candidates);
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        this.counters.cacheHits += 1;
        metrics.increment("smart_model_cache_hits_total");
        decision = cached.value;
        path = "cache";
      } else {
        try {
          decision = await this.askModel(text, namespace, candidates);
          this.cache.set(key, { expiresAt: Date.now() + this.config.smartModelCacheTTLSeconds * 1_000, value: decision });
          this.trimCache();
          path = "model";
        } catch (error) {
          this.counters.failures += 1;
          metrics.increment("smart_model_failures_total");
          logger.warn("Smart model failed; falling back to deterministic memory storage", { error: error instanceof Error ? error.message : String(error) });
          decision = { atoms: pieces.map(content => ({ content, ...classify(content), action: "create" as const })) };
          path = "deterministic";
        }
      }
    }

    if (input.store === false) return { stored: false, path, plan: decision.atoms };

    const results: Array<Record<string, unknown>> = [];
    for (const planned of decision.atoms) {
      if (planned.action === "skip") {
        results.push({ action: "skip", atomID: planned.targetAtomId ?? null, content: planned.content });
        continue;
      }

      if ((planned.action === "resolve" || planned.action === "deprecate") && planned.targetAtomId) {
        const target = candidates.find(candidate => candidate.id === planned.targetAtomId);
        if (target) {
          try {
            const status = planned.action === "resolve" ? "resolved" : "deprecated";
            const updated = await this.atoms.update({
              id: target.id,
              status,
              metadata: {
                ...target.metadata,
                lifecycle: {
                  state: status,
                  reason: planned.content,
                  changed_at: new Date().toISOString(),
                  managed_by: "memory_remember"
                }
              }
            });
            results.push({ action: planned.action, atomID: updated.id, status: updated.status });
            continue;
          } catch (error) {
            logger.warn("Smart lifecycle target could not be retired; storing the new statement instead", {
              target_atom_id: planned.targetAtomId,
              action: planned.action,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      const createInput: AtomCreateInput = {
        content: planned.content,
        namespace,
        kind: planned.kind,
        importance: planned.importance,
        confidence: 1,
        tags: normalizeTags(input.tags ?? []),
        source: input.source ?? {},
        dedupe: "merge"
      };
      if (planned.action === "supersede" && planned.targetAtomId) {
        try {
          const result = await this.atoms.supersede({ oldAtomID: planned.targetAtomId, replacement: createInput, archiveOld: true });
          results.push({ action: "supersede", atomID: result.replacementAtom.id, replacedAtomID: planned.targetAtomId });
          continue;
        } catch (error) {
          logger.warn("Smart supersede target was invalid; creating atom instead", { target_atom_id: planned.targetAtomId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const created = await this.atoms.create(createInput);
      results.push({ action: created.deduplicated ? "deduplicate" : "create", atomID: created.atom.id, created: created.created });
    }

    return { stored: true, path, modelCalled: path === "model", results };
  }

  private isEnabled(): boolean {
    if (this.config.smartModelEnabled === "off") return false;
    if (this.config.smartModelEnabled === "on") return true;
    return Boolean(this.config.smartModelAPIKey || !this.config.smartModelBaseURL.startsWith("https://api.openai.com/"));
  }

  private shouldUseModel(text: string, pieces: string[], candidates: SearchResult[], lifecycleHint = false): boolean {
    if (!this.isEnabled()) return false;
    if (!this.budgetAllows(text.length)) {
      this.counters.avoidedBudget += 1;
      metrics.increment("smart_model_avoided_budget_total");
      return false;
    }
    if (lifecycleHint && candidates.length > 0) return true;
    if (pieces.length > 1 && pieces.length <= 8) return candidates.some(candidate => candidate.lexical_score >= this.config.smartModelAmbiguousLexicalThreshold);
    if (text.length >= this.config.smartModelLongInputThreshold) return true;
    return candidates.some(candidate => candidate.lexical_score >= this.config.smartModelAmbiguousLexicalThreshold && candidate.lexical_score < this.config.smartModelDuplicateLexicalThreshold);
  }

  private resetBudgetWindow(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.budgetDay) return;
    this.budgetDay = day;
    this.dailyCalls = 0;
    this.dailyEstimatedInputTokens = 0;
  }

  private budgetAllows(inputCharacters: number): boolean {
    this.resetBudgetWindow();
    const estimatedTokens = Math.max(1, Math.ceil(Math.min(inputCharacters, this.config.smartModelMaxInputCharacters) / 4));
    const callsAllowed = this.config.smartModelDailyCallBudget === 0 || this.dailyCalls < this.config.smartModelDailyCallBudget;
    const tokensAllowed = this.config.smartModelDailyInputTokenBudget === 0 || this.dailyEstimatedInputTokens + estimatedTokens <= this.config.smartModelDailyInputTokenBudget;
    return callsAllowed && tokensAllowed;
  }

  private reserveBudget(inputCharacters: number): void {
    this.resetBudgetWindow();
    this.dailyCalls += 1;
    this.dailyEstimatedInputTokens += Math.max(1, Math.ceil(Math.min(inputCharacters, this.config.smartModelMaxInputCharacters) / 4));
  }

  private async lexicalCandidates(text: string, namespace: string): Promise<SearchResult[]> {
    const result = await this.atoms.search({ query: text.slice(0, 4_000), namespace, mode: "lexical", limit: 4 });
    return result.results;
  }

  private avoidDeterministic(): void {
    this.counters.avoidedDeterministic += 1;
    metrics.increment("smart_model_avoided_deterministic_total");
  }

  private cacheKey(text: string, namespace: string, candidates: SearchResult[]): string {
    return createHash("sha256").update(JSON.stringify({ text, namespace, candidates: candidates.map(candidate => [candidate.id, candidate.version]) })).digest("hex");
  }

  private trimCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    while (this.cache.size > this.config.smartModelCacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  private async askModel(text: string, namespace: string, candidates: SearchResult[]): Promise<SmartDecision> {
    if (!this.isEnabled()) throw new Error("Smart model is disabled");
    const candidatePayload = candidates.slice(0, 4).map(candidate => ({
      id: candidate.id,
      version: candidate.version,
      kind: candidate.kind,
      content: candidate.content.slice(0, 500),
      lexical: Number(candidate.lexical_score.toFixed(3))
    }));
    const input = [
      "Convert durable memory text into at most 8 atomic memory decisions. Return JSON only.",
      "For each item choose kind and importance 0..1, plus action=create|skip|supersede|resolve|deprecate.",
      "Use skip only for genuinely equivalent candidates.",
      "Use supersede when a new durable fact replaces an older candidate and the replacement itself should remain active.",
      "Use resolve only when the text clearly says an existing task, bug, incident, or temporary problem is fixed/completed/no longer outstanding.",
      "Use deprecate only when an existing candidate is obsolete or invalid without a direct replacement.",
      "resolve/deprecate/supersede must target one supplied candidate id. Do not invent ids or facts. Keep the original language. No explanations.",
      `namespace=${namespace}`,
      `text=${text.slice(0, this.config.smartModelMaxInputCharacters)}`,
      `candidates=${JSON.stringify(candidatePayload)}`,
      'schema={"atoms":[{"content":"...","kind":"fact","importance":0.5,"action":"create","targetAtomId":null}]}'
    ].join("\n");

    this.reserveBudget(input.length);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.smartModelTimeoutMs);
    const started = process.hrtime.bigint();
    try {
      const response = await fetch(`${this.config.smartModelBaseURL}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.config.smartModelAPIKey ? { Authorization: `Bearer ${this.config.smartModelAPIKey}` } : {})
        },
        body: JSON.stringify({
          model: this.config.smartModel,
          input,
          store: false,
          max_output_tokens: this.config.smartModelMaxOutputTokens,
          reasoning: { effort: "low" },
          text: {
            format: {
              type: "json_schema",
              name: "foundation_memory_decision",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  atoms: {
                    type: "array",
                    maxItems: 8,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        content: { type: "string" },
                        kind: { type: "string", enum: ["fact", "preference", "person", "event", "task", "note", "procedure", "concept", "observation"] },
                        importance: { type: "number", minimum: 0, maximum: 1 },
                        action: { type: "string", enum: ["create", "skip", "supersede", "resolve", "deprecate"] },
                        targetAtomId: { type: ["string", "null"] }
                      },
                      required: ["content", "kind", "importance", "action", "targetAtomId"]
                    }
                  }
                },
                required: ["atoms"]
              }
            }
          }
        })
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Smart model request failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 500)}`);
      this.counters.calls += 1;
      this.counters.inputTokens += Number(payload?.usage?.input_tokens ?? 0);
      this.counters.outputTokens += Number(payload?.usage?.output_tokens ?? 0);
      metrics.increment("smart_model_calls_total");
      metrics.increment("smart_model_input_tokens_total", Number(payload?.usage?.input_tokens ?? 0));
      metrics.increment("smart_model_output_tokens_total", Number(payload?.usage?.output_tokens ?? 0));
      metrics.observe("smart_model_request", Number(process.hrtime.bigint() - started) / 1e9);
      logger.info("Smart model memory decision", {
        reason: "ambiguous_write",
        model: this.config.smartModel,
        input_tokens: Number(payload?.usage?.input_tokens ?? 0),
        output_tokens: Number(payload?.usage?.output_tokens ?? 0),
        candidate_count: candidatePayload.length
      });
      return parseDecision(extractResponseText(payload), text);
    } finally {
      clearTimeout(timer);
    }
  }
}
