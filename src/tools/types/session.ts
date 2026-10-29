export type SessionState = {
  sessionId: string;
  extensionId: string;
  startedAt: string;
  ports: {
    anvil: number;
    fixtureServer: number;
  };
  stateMode: 'default' | 'onboarding' | 'custom';
};

export type SessionMetadata = {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  tags: string[];
  build?: {
    buildType?: 'build:test';
    extensionPathResolved?: string;
  };
  launch: {
    stateMode: 'default' | 'onboarding' | 'custom';
    fixturePreset?: string | null;
    extensionPath?: string;
    ports?: {
      anvil?: number;
      fixtureServer?: number;
    };
  };
};
