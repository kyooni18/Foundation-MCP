export const ATOM_KINDS = [
  "fact",
  "preference",
  "person",
  "event",
  "task",
  "note",
  "procedure",
  "concept",
  "observation"
] as const;

export const ATOM_STATUSES = [
  "active",
  "resolved",
  "superseded",
  "deprecated",
  "archived",
  "deleted"
] as const;

export type AtomKind = (typeof ATOM_KINDS)[number];
export type AtomStatus = (typeof ATOM_STATUSES)[number];
export type SearchMode = "hybrid" | "semantic" | "lexical";

export interface AtomRow {
  id: string;
  namespace: string;
  content: string;
  normalized_content: string;
  content_hash: string;
  summary: string | null;
  kind: AtomKind;
  status: AtomStatus;
  importance: number;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown>;
  source: Record<string, unknown>;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  version: number;
  access_count: number;
  last_accessed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SearchResult extends AtomRow {
  semantic_score: number;
  lexical_score: number;
  recency_score: number;
  access_score: number;
  feedback_score: number;
  score: number;
}

export interface AtomCreateInput {
  content: string;
  namespace?: string;
  summary?: string | null;
  kind?: AtomKind;
  importance?: number;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: Record<string, unknown>;
  expiresAt?: string | null;
  dedupe?: "merge" | "replace" | "error";
}

export interface AtomUpdateInput {
  id: string;
  expectedVersion?: number;
  content?: string;
  namespace?: string;
  summary?: string | null;
  kind?: AtomKind;
  status?: AtomStatus;
  importance?: number;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface AtomSearchInput {
  query: string;
  namespace?: string;
  kinds?: AtomKind[];
  tagsAny?: string[];
  tagsAll?: string[];
  statuses?: AtomStatus[];
  minImportance?: number;
  minConfidence?: number;
  createdAfter?: string;
  createdBefore?: string;
  includeExpired?: boolean;
  mode?: SearchMode;
  limit?: number;
  semanticWeight?: number;
  lexicalWeight?: number;
  recencyHalfLifeDays?: number;
}

export interface RelationRow {
  id: string;
  from_atom_id: string;
  to_atom_id: string;
  relation_type: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}
