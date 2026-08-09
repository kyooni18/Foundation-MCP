import type { AtomService } from "./atom-service.js";
import type { Config } from "./config.js";
import { SmartMemoryService } from "./smart-memory.js";
import type { AtomRow, SearchResult } from "./types.js";
import { normalizeContent, normalizeNamespace, normalizeTags } from "./utils.js";

type RememberInput = {
  text: string;
  namespace?: string;
  tags?: string[];
  source?: Record<string, unknown>;
  store?: boolean;
};

interface MemorySlot {
  slot: string;
  query: string;
  temporal: "current";
}

function slotPart(raw: string): string {
  return normalizeContent(raw)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function slotFromTag(tags: string[] | undefined): MemorySlot | null {
  const tagged = tags?.find(tag => /^(?:memory-slot|slot):/i.test(tag));
  if (!tagged) return null;
  const raw = tagged.replace(/^(?:memory-slot|slot):/i, "").trim();
  const slot = slotPart(raw);
  if (!slot) return null;
  return { slot: `explicit:${slot}`, query: raw, temporal: "current" };
}

function looksLikeLifecycleStatement(raw: string): boolean {
  const text = normalizeContent(raw).toLocaleLowerCase("und");
  return /\b(fixed|resolved|solved|completed|done|repaired|obsolete|deprecated|retired|no longer)\b|해결(?:됐|됨|했|완료)|고쳤|고쳐졌|수정(?:됐|됨|완료)|완료(?:됐|됨|했)|끝났|끝남|더 이상.{0,20}(?:아니|없)|폐기(?:됐|됨|했)|사용 중단|구식|무효/.test(text);
}

function looksHistorical(raw: string): boolean {
  const text = normalizeContent(raw).toLocaleLowerCase("und");
  return /\b(yesterday|last (?:week|month|year)|previously|formerly|in 20\d\d)\b|어제|지난(?:주|달|해|번)|예전|과거|당시/.test(text);
}

export function inferMemorySlot(raw: string, tags?: string[]): MemorySlot | null {
  const explicit = slotFromTag(tags);
  if (explicit) return explicit;

  const text = normalizeContent(raw);
  if (!text || text.length > 500 || text.includes("\n") || looksLikeLifecycleStatement(text) || looksHistorical(text)) return null;
  if (text.split(/(?<=[.!?。！？])\s+/).filter(Boolean).length > 1) return null;

  let match = text.match(/^선호하는\s+(.{1,80}?)(?:은|는|이|가)\s+(.+)$/u);
  if (match) {
    const field = slotPart(match[1]!);
    if (field) return { slot: `user:preference:${field}`, query: `선호 ${match[1]}`, temporal: "current" };
  }

  match = text.match(/^(.{1,80}?)의\s+(.{1,80}?)(?:은|는|이|가)\s+(.+)$/u);
  if (match) {
    const subject = slotPart(match[1]!);
    const field = slotPart(match[2]!);
    if (subject && field) return { slot: `${subject}:${field}`, query: `${match[1]} ${match[2]}`, temporal: "current" };
  }

  match = text.match(/^(?:the\s+)?preferred\s+(.{1,80}?)\s+(?:is|are|=|:)\s+(.+)$/i);
  if (match) {
    const field = slotPart(match[1]!);
    if (field) return { slot: `user:preference:${field}`, query: `preferred ${match[1]}`, temporal: "current" };
  }

  match = text.match(/^(?:my|user(?:['’]s)?)\s+(.{1,80}?)\s+(?:is|are|=|:)\s+(.+)$/i);
  if (match) {
    const field = slotPart(match[1]!);
    if (field) return { slot: `user:${field}`, query: match[1]!, temporal: "current" };
  }

  match = text.match(/^(.{1,80}?)(?:['’]s)\s+(.{1,80}?)\s+(?:is|are|=|:)\s+(.+)$/i);
  if (match) {
    const subject = slotPart(match[1]!);
    const field = slotPart(match[2]!);
    if (subject && field) return { slot: `${subject}:${field}`, query: `${match[1]} ${match[2]}`, temporal: "current" };
  }

  match = text.match(/^(?:the\s+)?(.{1,80}?)\s+for\s+(.{1,80}?)\s+(?:is|are|=|:)\s+(.+)$/i);
  if (match) {
    const field = slotPart(match[1]!);
    const subject = slotPart(match[2]!);
    if (subject && field) return { slot: `${subject}:${field}`, query: `${match[2]} ${match[1]}`, temporal: "current" };
  }

  match = text.match(/^(.{1,80}?)\s+(version|profile|mode|status|target|endpoint|port|theme|model|provider|branch|database|db|host|url)\s+(?:is|are|=|:)\s+(.+)$/i);
  if (match) {
    const subject = slotPart(match[1]!);
    const field = slotPart(match[2]!);
    if (subject && field) return { slot: `${subject}:${field}`, query: `${match[1]} ${match[2]}`, temporal: "current" };
  }

  return null;
}

function metadataSlot(atom: AtomRow | SearchResult): string | null {
  const memory = atom.metadata?.memory;
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) return null;
  const slot = (memory as Record<string, unknown>).slot;
  return typeof slot === "string" && slot.trim() ? slot.trim() : null;
}

function atomSlot(atom: AtomRow | SearchResult): string | null {
  return metadataSlot(atom) ?? inferMemorySlot(atom.content, atom.tags)?.slot ?? null;
}

function slotMetadata(existing: Record<string, unknown>, slot: MemorySlot): Record<string, unknown> {
  const previous = existing.memory;
  const previousMemory = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : {};
  return {
    ...existing,
    memory: {
      ...previousMemory,
      slot: slot.slot,
      temporal: slot.temporal,
      managed_by: "memory_remember",
      updated_at: new Date().toISOString()
    }
  };
}

export class SlotAwareSmartMemoryService extends SmartMemoryService {
  constructor(config: Config, private readonly slotAtoms: AtomService) {
    super(config, slotAtoms);
  }

  override async remember(input: RememberInput): Promise<Record<string, unknown>> {
    const text = normalizeContent(input.text);
    const namespace = normalizeNamespace(input.namespace ?? "default");
    const slot = inferMemorySlot(text, input.tags);
    if (!slot) return super.remember(input);

    const candidates = await this.slotCandidates(slot, namespace);
    const exact = candidates.find(candidate => normalizeContent(candidate.content) === text);
    if (exact) {
      const result = await super.remember(input);
      if (input.store !== false) await this.annotateAtom(exact.id, slot);
      return { ...result, memorySlot: slot.slot };
    }

    if (candidates.length === 1) {
      const old = candidates[0]!;
      if (input.store === false) {
        return {
          stored: false,
          path: "deterministic",
          memorySlot: slot.slot,
          plan: [{
            content: text,
            kind: old.kind,
            importance: old.importance,
            action: "supersede",
            targetAtomId: old.id
          }]
        };
      }

      const replacement = await this.slotAtoms.supersede({
        oldAtomID: old.id,
        replacement: {
          content: text,
          namespace,
          kind: old.kind,
          importance: old.importance,
          confidence: old.confidence,
          tags: normalizeTags([...(old.tags ?? []), ...(input.tags ?? [])]),
          metadata: slotMetadata(old.metadata, slot),
          source: input.source ?? {},
          dedupe: "merge"
        },
        archiveOld: true
      });
      return {
        stored: true,
        path: "deterministic",
        modelCalled: false,
        memorySlot: slot.slot,
        results: [{
          action: "supersede",
          reason: "same_memory_slot",
          atomID: replacement.replacementAtom.id,
          replacedAtomID: old.id
        }]
      };
    }

    const result = await super.remember(input);
    if (input.store !== false) await this.annotateResult(result, slot);
    return { ...result, memorySlot: slot.slot };
  }

  private async slotCandidates(slot: MemorySlot, namespace: string): Promise<Array<AtomRow | SearchResult>> {
    if (slot.slot.startsWith("explicit:")) {
      const listed = await this.slotAtoms.list({ namespace, statuses: ["active"], limit: 200, sort: "updated" });
      const tagged = listed.atoms.filter(candidate => atomSlot(candidate) === slot.slot);
      if (tagged.length) return tagged;
    }

    const search = await this.slotAtoms.search({
      query: slot.query,
      namespace,
      mode: "lexical",
      statuses: ["active"],
      includeExpired: false,
      limit: 8
    });
    return search.results.filter(candidate => atomSlot(candidate) === slot.slot);
  }

  private async annotateResult(result: Record<string, unknown>, slot: MemorySlot): Promise<void> {
    const rows = Array.isArray(result.results) ? result.results : [];
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      if (!["create", "deduplicate", "supersede"].includes(String(item.action ?? ""))) continue;
      if (typeof item.atomID === "string") ids.add(item.atomID);
    }
    await Promise.all([...ids].map(id => this.annotateAtom(id, slot)));
  }

  private async annotateAtom(id: string, slot: MemorySlot): Promise<void> {
    try {
      const atom = await this.slotAtoms.get(id);
      if (atom.status !== "active" || metadataSlot(atom) === slot.slot) return;
      await this.slotAtoms.update({ id, metadata: slotMetadata(atom.metadata, slot) });
    } catch {
      // Slot metadata is an optimization. A successful memory write must not fail
      // solely because best-effort annotation raced with another mutation.
    }
  }
}
