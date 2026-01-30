declare module "openclaw/plugin-sdk" {
  export type OpenclawConfig = {
    channels?: {
      wecom?: {
        accounts?: Record<string, unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    session?: { store?: string };
    gateway?: { bind?: string };
    [key: string]: unknown;
  };

  export type PluginRuntime = {
    logging?: {
      shouldLogVerbose?: () => boolean;
    };
    channel: {
      routing: {
        resolveAgentRoute: (params: {
          cfg: OpenclawConfig;
          channel: string;
          accountId: string;
          peer: { kind: string; id: string };
        }) => { agentId: string; sessionKey: string; accountId: string };
      };
      session: {
        resolveStorePath: (store: string | undefined, params: { agentId: string }) => string;
        readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
        recordInboundSession: (params: {
          storePath: string;
          sessionKey: string;
          ctx: Record<string, unknown>;
          onRecordError?: (err: unknown) => void;
        }) => Promise<void>;
      };
      reply: {
        resolveEnvelopeFormatOptions: (cfg: OpenclawConfig) => Record<string, unknown>;
        formatAgentEnvelope: (params: {
          channel: string;
          from: string;
          previousTimestamp: number | undefined;
          envelope: Record<string, unknown>;
          body: string;
        }) => string;
        finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown> & { SessionKey?: string };
        dispatchReplyWithBufferedBlockDispatcher: (params: {
          ctx: Record<string, unknown>;
          cfg: OpenclawConfig;
          dispatcherOptions: {
            deliver: (payload: { text?: string }) => Promise<void>;
            onError?: (err: unknown, info: { kind: string }) => void;
          };
        }) => Promise<void>;
      };
      text: {
        resolveMarkdownTableMode: (params: {
          cfg: OpenclawConfig;
          channel: string;
          accountId: string;
        }) => string;
        convertMarkdownTables: (text: string, mode: string) => string;
      };
    };
  };

  export type ChannelAccountSnapshot = {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    webhookPath?: string;
    [key: string]: unknown;
  };

  export type SendResult = {
    channel: string;
    ok: boolean;
    messageId: string;
    error?: Error;
  };

  export type GatewayContext<TAccount> = {
    account: TAccount;
    accountId: string;
    cfg: OpenclawConfig;
    runtime: {
      log?: (message: string) => void;
      error?: (message: string) => void;
    };
    log?: {
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
    setStatus: (status: Record<string, unknown>) => void;
  };

  export type ChannelPlugin<TAccount> = {
    id: string;
    meta: {
      id: string;
      label: string;
      selectionLabel: string;
      docsPath: string;
      docsLabel: string;
      blurb: string;
      aliases: string[];
      order: number;
      quickstartAllowFrom?: boolean;
    };
    capabilities: {
      chatTypes: string[];
      media: boolean;
      reactions: boolean;
      threads: boolean;
      polls: boolean;
      nativeCommands: boolean;
      blockStreaming: boolean;
    };
    reload: { configPrefixes: string[] };
    configSchema: unknown;
    config: {
      listAccountIds: (cfg: OpenclawConfig) => string[];
      resolveAccount: (cfg: OpenclawConfig, accountId: string) => TAccount;
      defaultAccountId: (cfg: OpenclawConfig) => string;
      setAccountEnabled: (params: { cfg: OpenclawConfig; accountId: string; enabled: boolean }) => void;
      deleteAccount: (params: { cfg: OpenclawConfig; accountId: string }) => void;
      isConfigured: (account: TAccount) => boolean;
      describeAccount: (account: TAccount) => ChannelAccountSnapshot;
      resolveAllowFrom: (params: { cfg: OpenclawConfig; accountId: string }) => string[];
      formatAllowFrom: (params: { allowFrom: string[] }) => string[];
    };
    security: {
      resolveDmPolicy: (params: {
        cfg: OpenclawConfig;
        accountId: string;
        account: TAccount;
      }) => {
        policy: string;
        allowFrom: string[];
        policyPath: string;
        allowFromPath: string;
        approveHint: string;
        normalizeEntry: (raw: string) => string;
      };
    };
    groups: {
      resolveRequireMention: () => boolean;
    };
    threading: {
      resolveReplyToMode: () => string;
    };
    messaging: {
      normalizeTarget: (raw: string) => string | undefined;
      targetResolver: {
        looksLikeId: (raw: string) => boolean;
        hint: string;
      };
    };
    outbound: {
      deliveryMode: string;
      chunkerMode: string;
      textChunkLimit: number;
      sendText: (params: {
        account: TAccount;
        target: string;
        text: string;
      }) => Promise<SendResult>;
      sendMedia: (params: {
        account: TAccount;
        target: string;
        filePath?: string;
        buffer?: Buffer;
        mimeType?: string;
        filename?: string;
      }) => Promise<SendResult>;
    };
    status: {
      defaultRuntime: Record<string, unknown>;
      buildChannelSummary: (params: { snapshot: Record<string, unknown> }) => Record<string, unknown>;
      probeAccount: () => Promise<{ ok: boolean }>;
      buildAccountSnapshot: (params: {
        account: TAccount;
        runtime?: Record<string, unknown>;
      }) => Record<string, unknown>;
    };
    gateway: {
      startAccount: (ctx: GatewayContext<TAccount>) => Promise<{ stop: () => void }>;
      stopAccount: (ctx: GatewayContext<TAccount>) => Promise<void>;
    };
  };

  export const DEFAULT_ACCOUNT_ID: string;
  export function normalizeAccountId(accountId: string | null | undefined): string;
  export function defineChannelConfigSchema(schema: unknown): unknown;
  export function setAccountEnabledInConfigSection(params: {
    cfg: OpenclawConfig;
    sectionKey: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
  }): void;
  export function deleteAccountFromConfigSection(params: {
    cfg: OpenclawConfig;
    sectionKey: string;
    clearBaseFields?: string[];
    accountId: string;
  }): void;
  export function formatPairingApproveHint(channel: string): string;

  export type OpenclawPluginApi = {
    runtime: PluginRuntime;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerChannel: (params: { plugin: ChannelPlugin<any> }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerHttpHandler: (handler: (req: any, res: any) => Promise<boolean>) => void;
  };

  export function emptyPluginConfigSchema(): unknown;

  export type ChannelConfigSchema = {
    schema: Record<string, unknown>;
  };
}
