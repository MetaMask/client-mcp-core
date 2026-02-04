import type { Page, BrowserContext } from '@playwright/test';

/**
 *
 */
export type StateMode = 'default' | 'onboarding' | 'custom';

/**
 *
 */
export type NetworkMode = 'localhost' | 'fork' | 'custom';

/**
 *
 */
export type NetworkConfig = {
  /**
   *
   */
  mode?: NetworkMode;
  /**
   *
   */
  chainId?: number;
  /**
   *
   */
  rpcUrl?: string;
  /**
   *
   */
  forkBlockNumber?: number;
  /**
   *
   */
  chainName?: string;
  /**
   *
   */
  nativeCurrency?: {
    /**
     *
     */
    symbol: string;
    /**
     *
     */
    decimals: number;
  };
};

/**
 *
 */
export type FixtureData = {
  /**
   *
   */
  data: Record<string, unknown>;
  /**
   *
   */
  meta?: {
    /**
     *
     */
    version: number;
  };
};

/**
 *
 */
export type PortsConfig = {
  /**
   *
   */
  anvil?: number;
  /**
   *
   */
  fixtureServer?: number;
};

/**
 *
 */
export type ScreenshotOptions = {
  /**
   *
   */
  name: string;
  /**
   *
   */
  fullPage?: boolean;
  /**
   *
   */
  selector?: string;
  /**
   *
   */
  timestamp?: boolean;
  /**
   *
   */
  page?: Page;
};

/**
 *
 */
export type ScreenshotResult = {
  /**
   *
   */
  path: string;
  /**
   *
   */
  base64: string;
  /**
   *
   */
  width: number;
  /**
   *
   */
  height: number;
};

/**
 *
 */
export type ScreenName =
  | 'unlock'
  | 'home'
  | 'onboarding-welcome'
  | 'onboarding-import'
  | 'onboarding-create'
  | 'onboarding-srp'
  | 'onboarding-password'
  | 'onboarding-complete'
  | 'onboarding-metametrics'
  | 'settings'
  | 'send'
  | 'swap'
  | 'bridge'
  | 'confirm-transaction'
  | 'confirm-signature'
  | 'notification'
  | 'unknown';

/**
 *
 */
export type ExtensionState = {
  /**
   *
   */
  isLoaded: boolean;
  /**
   *
   */
  currentUrl: string;
  /**
   *
   */
  extensionId: string;
  /**
   *
   */
  isUnlocked: boolean;
  /**
   *
   */
  currentScreen: ScreenName;
  /**
   *
   */
  accountAddress: string | null;
  /**
   *
   */
  networkName: string | null;
  /**
   *
   */
  chainId: number | null;
  /**
   *
   */
  balance: string | null;
};

/**
 *
 */
export type LaunchOptions = {
  /**
   *
   */
  extensionPath?: string;
  /**
   *
   */
  viewportWidth?: number;
  /**
   *
   */
  viewportHeight?: number;
  /**
   *
   */
  slowMo?: number;
  /**
   *
   */
  autoBuild?: boolean;
  /**
   *
   */
  stateMode?: StateMode;
  /**
   *
   */
  fixture?: FixtureData;
  /**
   *
   */
  ports?: PortsConfig;
  /**
   *
   */
  seedContracts?: string[];
};

/**
 *
 */
export type BrowserSession = {
  /**
   *
   */
  context: BrowserContext;
  /**
   *
   */
  extensionPage: Page;
  /**
   *
   */
  extensionId: string;
};

/**
 *
 */
export type BuildOptions = {
  /**
   *
   */
  buildType?: string;
  /**
   *
   */
  force?: boolean;
};

/**
 *
 */
export type BuildResult = {
  /**
   *
   */
  success: boolean;
  /**
   *
   */
  extensionPath: string;
  /**
   *
   */
  durationMs: number;
  /**
   *
   */
  error?: string;
};

/**
 *
 */
export type WalletState = FixtureData;

/**
 *
 */
export type DeployOptions = {
  /**
   *
   */
  hardfork?: string;
  /**
   *
   */
  deployerOptions?: {
    /**
     *
     */
    fromAddress?: string;
    /**
     *
     */
    fromPrivateKey?: string;
  };
};

/**
 *
 */
export type ContractDeployment = {
  /**
   *
   */
  name: string;
  /**
   *
   */
  address: string;
  /**
   *
   */
  deployedAt: string;
};

/**
 *
 */
export type ContractInfo = {
  /**
   *
   */
  name: string;
  /**
   *
   */
  address: string;
  /**
   *
   */
  deployedAt: string;
};

/**
 *
 */
export type StateSnapshot = ExtensionState;

/**
 *
 */
export type StateOptions = {
  /**
   *
   */
  extensionId?: string;
  /**
   *
   */
  chainId?: number;
};

/**
 *
 */
export type OnboardOptions = {
  /**
   *
   */
  seedPhrase?: string;
  /**
   *
   */
  password?: string;
};

/**
 *
 */
export type Observation = {
  /**
   *
   */
  state: ExtensionState;
  /**
   *
   */
  testIds: string[];
  /**
   *
   */
  a11yNodes: unknown[];
};

/**
 *
 */
export type BuildCapability = {
  build(options?: BuildOptions): Promise<BuildResult>;
  getExtensionPath(): string;
  isBuilt(): Promise<boolean>;
};

/**
 *
 */
export type FixtureCapability = {
  start(state: WalletState): Promise<void>;
  stop(): Promise<void>;
  getDefaultState(): WalletState;
  getOnboardingState(): WalletState;
  resolvePreset(presetName: string): WalletState;
};

/**
 *
 */
export type ChainCapability = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  setPort(port: number): void;
};

/**
 *
 */
export type ContractSeedingCapability = {
  deployContract(
    name: string,
    options?: DeployOptions,
  ): Promise<ContractDeployment>;
  deployContracts(
    names: string[],
    options?: DeployOptions,
  ): Promise<{
    /**
     *
     */
    deployed: ContractDeployment[];
    /**
     *
     */
    failed: {
      /**
       *
       */
      name: string;
      /**
       *
       */
      error: string;
    }[];
  }>;
  getContractAddress(name: string): string | null;
  listDeployedContracts(): ContractInfo[];
  getAvailableContracts(): string[];
  clearRegistry(): void;
  initialize(): void;
};

/**
 *
 */
export type StateSnapshotCapability = {
  getState(page: Page, options: StateOptions): Promise<StateSnapshot>;
  detectCurrentScreen(page: Page): Promise<string>;
};

/**
 *
 */
export type MockServerCapability = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getServer(): unknown;
  getPort(): number;
};
