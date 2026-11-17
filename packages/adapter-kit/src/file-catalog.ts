/** Catalog identifiers and compact metadata only; host storage paths stay in adapters. */
export interface FileCatalogQuery {
  query: string;
  cursor?: string;
  limit?: number;
}

export interface FileCatalogPage {
  files: Array<{ id: string; name: string; bytes: number; sha256: string }>;
  nextCursor?: string;
}

export interface FileCatalogIdentity {
  spaceId: string;
  userId: string;
  botId: string;
}

/** Submitting requests does not authorize retrieval or expose host destinations. */
export interface FileCatalogProvider {
  search(identity: FileCatalogIdentity, query: FileCatalogQuery): Promise<FileCatalogPage>;
  request(identity: FileCatalogIdentity, fileId: string): Promise<{ packetId: string }>;
}
