export interface SemanticItem {
    id: string;
    text: string;
}
/**
 * Cosine similarity per catalog id. Returns an empty map when the local model
 * is missing or fails, so the caller keeps its lexical ranking untouched.
 */
export declare function semanticScores(items: readonly SemanticItem[], query: string, cacheDir: string): Promise<Map<string, number>>;
export declare function warmSemantic(items: readonly SemanticItem[], cacheDir: string): Promise<boolean>;
