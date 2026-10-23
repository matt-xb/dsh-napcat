export interface StickerMatch {
    id: string;
    path: string;
    recentlyUsed: boolean;
    tags: string[];
    title: string;
    description: string;
    useWhen: string;
    avoid: string;
    score: number;
}
/** Only the current chat selects a scope; query never selects paths or catalogs. */
export declare function findStickers(chatKey: string, query: string, root?: string, recentImages?: readonly string[]): Promise<StickerMatch[]>;
