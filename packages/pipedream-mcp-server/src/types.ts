/** Anything that can hand out a Pipedream access token (direct OAuth or via the broker). */
export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface Config {
  auth: TokenProvider;
  projectId: string;
  environment: string;
  externalUserId: string;
}

export interface TokenData {
  accessToken: string;
  expiresAt: number;
}

/** One healthy connected account of an app (an app can have several, e.g. three Outlook mailboxes). */
export interface AppAccount {
  id: string;
  name: string | null;
}

export interface AppConnection {
  slug: string;
  name: string;
  /** Every healthy account for this app, in Pipedream's order. Never empty. */
  accounts: AppAccount[];
  healthy: boolean;
  authType: string;
}

export interface PipedreamAccount {
  id: string;
  name: string | null;
  external_id: string;
  healthy: boolean;
  dead: boolean | null;
  app: {
    id: string;
    name_slug: string;
    name: string;
    auth_type: string;
    description: string;
  };
  created_at: string;
  updated_at: string;
}

export interface PipedreamListResponse {
  data: PipedreamAccount[];
  page_info: {
    total_count: number;
    count: number;
    start_cursor?: string;
    end_cursor?: string;
  };
}

export interface ToolMapping {
  appSlug: string;
  originalName: string;
}
