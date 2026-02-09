/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable id-length */
import { promises as fs } from 'fs';
import * as path from 'path';

import {
  expandWithSynonyms,
  tokenize,
  tokenizeIdentifier,
} from './tokenization.js';
import type {
  StepRecord,
  StepRecordTool,
  StepRecordObservation,
  StepRecordOutcome,
  TestIdItem,
  A11yNodeTrimmed,
  KnowledgeStepSummary,
  RecipeStep,
  SessionMetadata,
  KnowledgeScope,
  KnowledgeFilters,
  SessionSummary,
  PriorKnowledgeV1,
  PriorKnowledgeContext,
  PriorKnowledgeSimilarStep,
  PriorKnowledgeSuggestedAction,
  PriorKnowledgeAvoid,
  PriorKnowledgeRelatedSession,
  PriorKnowledgeTarget,
} from './types';
import {
  generateFilesafeTimestamp,
  isSensitiveField,
  SENSITIVE_FIELD_PATTERNS,
  debugWarn,
} from './utils';
import type { ExtensionState } from '../capabilities/types.js';

const KNOWLEDGE_ROOT = 'test-artifacts/llm-knowledge';
const SCHEMA_VERSION = 1;

const PRIOR_KNOWLEDGE_CONFIG = {
  /** Look back 48 hours for related sessions - balances recency with having enough data */
  windowHours: 48,
  /** Limit to 5 related sessions to keep context focused and token-efficient */
  maxRelatedSessions: 5,
  /** Maximum 10 similar steps to include - prevents overwhelming the context */
  maxSimilarSteps: 10,
  /** Limit to 5 suggested actions to keep recommendations focused and actionable */
  maxSuggestedActions: 5,
  /** Maximum 5 items in avoid list to prevent excessive warnings */
  maxAvoid: 5,
  /** Require at least 2 failures before suggesting avoidance - prevents false positives */
  minAvoidFailureCount: 2,
} as const;

const SCAN_LIMITS = {
  /** Scan up to 20 sessions to balance thoroughness with performance */
  maxSessionsToScan: 20,
  /** Limit to 500 steps per session to avoid memory issues with large sessions */
  maxStepsPerSession: 500,
  /** Hard limit of 2000 total steps across all sessions to prevent excessive scanning */
  maxTotalSteps: 2000,
} as const;

const SIMILARITY_WEIGHTS = {
  /** Highest weight - same screen is the strongest indicator of relevance */
  sameScreen: 8,
  /** URL path overlap indicates similar context/feature area */
  urlPathOverlap: 6,
  /** Test ID overlap shows similar UI elements are present */
  testIdOverlap: 3,
  /** Accessibility node overlap provides additional context matching */
  a11yOverlap: 2,
  /** Actionable tools (click, type, etc.) are more relevant than discovery tools */
  actionableTool: 2,
} as const;

const MAX_SIMILARITY_SCORE =
  SIMILARITY_WEIGHTS.sameScreen +
  SIMILARITY_WEIGHTS.urlPathOverlap +
  SIMILARITY_WEIGHTS.testIdOverlap * 3 +
  SIMILARITY_WEIGHTS.a11yOverlap * 2 +
  SIMILARITY_WEIGHTS.actionableTool;

/**
 * Configuration options for KnowledgeStore initialization
 */
export type KnowledgeStoreConfig = {
  /**
   * Root directory for storing knowledge artifacts
   */
  rootDir?: string;
  /**
   * Prefix for session IDs (default: 'mm-')
   */
  sessionIdPrefix?: string;
  /**
   * Prefix for tool names (default: 'mm')
   */
  toolPrefix?: string;
};

/**
 * Extract path tokens from URL hash fragment
 *
 * @param url - The URL to extract tokens from
 * @returns Array of path tokens from the hash fragment
 */
function extractPathTokens(url: string): string[] {
  try {
    const hashPart = url.split('#')[1] ?? '';
    return hashPart
      .split('/')
      .filter((t) => t.length > 0 && !t.startsWith('0x'));
  } catch (error) {
    debugWarn('knowledge-store.extractPathTokens', error);
    return [];
  }
}

/**
 * Persistent cross-session knowledge store for recording and querying tool invocations.
 */
export class KnowledgeStore {
  readonly #knowledgeRoot: string;

  readonly #sessionIdPrefix: string;

  readonly #toolPrefix: string;

  readonly #sessionMetadataCache: Map<string, SessionMetadata | null> =
    new Map();

  readonly #actionableTools: string[];

  readonly #toolActionMap: Record<
    string,
    PriorKnowledgeSuggestedAction['action']
  >;

  readonly #discoveryTools: string[];

  /**
   * Initialize KnowledgeStore with optional configuration
   *
   * @param config - Configuration options for the store
   */
  constructor(config: KnowledgeStoreConfig = {}) {
    this.#knowledgeRoot =
      config.rootDir ?? path.join(process.cwd(), KNOWLEDGE_ROOT);
    this.#sessionIdPrefix = config.sessionIdPrefix ?? 'mm-';
    this.#toolPrefix = config.toolPrefix ?? 'mm';

    const prefix = this.#toolPrefix;
    this.#actionableTools = [
      `${prefix}_click`,
      `${prefix}_type`,
      `${prefix}_wait_for`,
      `${prefix}_navigate`,
      `${prefix}_wait_for_notification`,
    ];

    this.#toolActionMap = {
      [`${prefix}_click`]: 'click',
      [`${prefix}_type`]: 'type',
      [`${prefix}_wait_for`]: 'wait_for',
      [`${prefix}_navigate`]: 'navigate',
      [`${prefix}_wait_for_notification`]: 'wait_for_notification',
    };

    this.#discoveryTools = [
      `${prefix}_describe_screen`,
      `${prefix}_list_testids`,
      `${prefix}_accessibility_snapshot`,
      `${prefix}_get_state`,
    ];
  }

  /**
   * Write session metadata to disk
   *
   * @param metadata - Session metadata to persist
   * @returns Path to the written metadata file
   */
  async writeSessionMetadata(metadata: SessionMetadata): Promise<string> {
    const sessionDir = path.join(this.#knowledgeRoot, metadata.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const filepath = path.join(sessionDir, 'session.json');
    await fs.writeFile(filepath, JSON.stringify(metadata, null, 2));

    this.#sessionMetadataCache.set(metadata.sessionId, metadata);

    return filepath;
  }

  /**
   * Read session metadata from disk (private)
   *
   * @param sessionId - Session ID to read metadata for
   * @returns Session metadata or null if not found
   */
  async #readSessionMetadata(
    sessionId: string,
  ): Promise<SessionMetadata | null> {
    if (this.#sessionMetadataCache.has(sessionId)) {
      return this.#sessionMetadataCache.get(sessionId) ?? null;
    }

    const filepath = path.join(this.#knowledgeRoot, sessionId, 'session.json');

    try {
      const content = await fs.readFile(filepath, 'utf-8');
      const metadata = JSON.parse(content) as SessionMetadata;
      this.#sessionMetadataCache.set(sessionId, metadata);
      return metadata;
    } catch (error) {
      debugWarn('knowledge-store.readSessionMetadata', error);
      this.#sessionMetadataCache.set(sessionId, null);
      return null;
    }
  }

  /**
   * List sessions with optional filtering and limit
   *
   * @param limit - Maximum number of sessions to return
   * @param filters - Optional filters for sessions
   * @returns Array of session summaries
   */
  async listSessions(
    limit: number,
    filters?: KnowledgeFilters,
  ): Promise<SessionSummary[]> {
    const sessionIds = await this.getAllSessionIds();
    const sessions: {
      metadata: SessionMetadata;
      createdAt: Date;
    }[] = [];

    for (const sid of sessionIds) {
      const metadata = await this.#readSessionMetadata(sid);
      if (!metadata) {
        continue;
      }

      if (!this.#matchesFilters(metadata, filters)) {
        continue;
      }

      sessions.push({
        metadata,
        createdAt: new Date(metadata.createdAt),
      });
    }

    sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return sessions.slice(0, limit).map((s) => ({
      sessionId: s.metadata.sessionId,
      createdAt: s.metadata.createdAt,
      goal: s.metadata.goal,
      flowTags: s.metadata.flowTags,
      tags: s.metadata.tags,
    }));
  }

  /**
   * Check if session metadata matches the given filters
   *
   * @param metadata - Session metadata to check
   * @param filters - Filters to apply
   * @returns True if metadata matches all filters
   */
  #matchesFilters(
    metadata: SessionMetadata,
    filters?: KnowledgeFilters,
  ): boolean {
    if (!filters) {
      return true;
    }

    if (filters.flowTag && !metadata.flowTags.includes(filters.flowTag)) {
      return false;
    }

    if (filters.tag && !metadata.tags.includes(filters.tag)) {
      return false;
    }

    if (filters.sinceHours) {
      const cutoff = Date.now() - filters.sinceHours * 60 * 60 * 1000;
      const createdAt = new Date(metadata.createdAt).getTime();
      if (createdAt < cutoff) {
        return false;
      }
    }

    return true;
  }

  /**
   * Resolve session IDs based on scope and filters
   *
   * @param scope - Scope for session resolution (current, all, or specific sessionId)
   * @param currentSessionId - Current session ID for scope resolution
   * @param filters - Optional filters to apply to sessions
   * @returns Array of resolved session IDs
   */
  async resolveSessionIds(
    scope: KnowledgeScope,
    currentSessionId: string | undefined,
    filters?: KnowledgeFilters,
  ): Promise<string[]> {
    if (scope === 'current') {
      return currentSessionId ? [currentSessionId] : [];
    }

    if (typeof scope === 'object' && 'sessionId' in scope) {
      return [scope.sessionId];
    }

    const allIds = await this.getAllSessionIds();

    if (!filters) {
      return allIds;
    }

    const filtered: string[] = [];
    for (const sid of allIds) {
      const metadata = await this.#readSessionMetadata(sid);
      if (metadata && this.#matchesFilters(metadata, filters)) {
        filtered.push(sid);
      } else if (!metadata) {
        filtered.push(sid);
      }
    }

    return filtered;
  }

  /**
   * Record a tool execution step with context and artifacts
   *
   * @param params - Step recording parameters
   * @param params.sessionId - Session ID for this step
   * @param params.toolName - Name of the tool executed
   * @param params.input - Tool input parameters
   * @param params.target - Target element information
   * @param params.outcome - Execution outcome (success/failure)
   * @param params.observation - Observed state after execution
   * @param params.durationMs - Execution duration in milliseconds
   * @param params.screenshotPath - Path to screenshot artifact
   * @param params.screenshotDimensions - Screenshot dimensions
   * @param params.screenshotDimensions.width - Screenshot width in pixels
   * @param params.screenshotDimensions.height - Screenshot height in pixels
   * @param params.context - Execution context (e2e or prod)
   * @param params.automationPlatform - The automation platform ('browser' or 'ios')
   * @returns Path to the recorded step file
   */
  async recordStep(params: {
    sessionId: string;
    toolName: string;
    input?: Record<string, unknown>;
    target?: StepRecordTool['target'];
    outcome: StepRecordOutcome;
    observation: StepRecordObservation;
    durationMs?: number;
    screenshotPath?: string;
    screenshotDimensions?: {
      /**
       * Screenshot width in pixels
       */
      width: number;
      /**
       * Screenshot height in pixels
       */
      height: number;
    };
    context?: 'e2e' | 'prod';
    automationPlatform?: 'browser' | 'ios';
  }): Promise<string> {
    const timestamp = new Date();
    const filesafeTimestamp = generateFilesafeTimestamp(timestamp);

    const sessionDir = path.join(this.#knowledgeRoot, params.sessionId);
    const stepsDir = path.join(sessionDir, 'steps');
    await fs.mkdir(stepsDir, { recursive: true });

    const sanitizedInput = this.#sanitizeInput(params.toolName, params.input);
    const labels = this.#computeLabels(
      params.toolName,
      params.target,
      params.outcome,
    );

    const stepRecord: StepRecord = {
      schemaVersion: SCHEMA_VERSION,
      timestamp: timestamp.toISOString(),
      sessionId: params.sessionId,
      context: params.context,
      environment: this.#getEnvironmentInfo(),
      tool: {
        name: params.toolName,
        input: sanitizedInput.input,
        target: params.target,
        textRedacted: sanitizedInput.textRedacted,
        textLength: sanitizedInput.textLength,
      },
      timing: {
        durationMs: params.durationMs,
      },
      outcome: params.outcome,
      observation: params.observation,
      labels,
      automationPlatform: params.automationPlatform,
    };

    if (params.screenshotPath) {
      stepRecord.artifacts = {
        screenshot: {
          path: params.screenshotPath,
          width: params.screenshotDimensions?.width,
          height: params.screenshotDimensions?.height,
        },
      };
    }

    const filename = `${filesafeTimestamp}-${params.toolName}.json`;
    const filepath = path.join(stepsDir, filename);

    await fs.writeFile(filepath, JSON.stringify(stepRecord, null, 2));

    return filepath;
  }

  /**
   * Compute labels for a step based on tool and outcome
   *
   * @param toolName - Name of the tool executed
   * @param target - Target element information
   * @param outcome - Execution outcome
   * @returns Array of labels describing the step
   */
  #computeLabels(
    toolName: string,
    target?: StepRecordTool['target'],
    outcome?: StepRecordOutcome,
  ): string[] {
    const labels: string[] = [];

    const navigationTools = [
      `${this.#toolPrefix}_navigate`,
      `${this.#toolPrefix}_wait_for_notification`,
    ];
    const interactionTools = [
      `${this.#toolPrefix}_click`,
      `${this.#toolPrefix}_type`,
      `${this.#toolPrefix}_wait_for`,
    ];

    if (this.#discoveryTools.includes(toolName)) {
      labels.push('discovery');
    } else if (navigationTools.includes(toolName)) {
      labels.push('navigation');
    } else if (interactionTools.includes(toolName)) {
      labels.push('interaction');

      const targetStr = JSON.stringify(target ?? {}).toLowerCase();
      if (
        targetStr.includes('confirm') ||
        targetStr.includes('approve') ||
        targetStr.includes('submit')
      ) {
        labels.push('confirmation');
      }
    }

    if (outcome && !outcome.ok) {
      labels.push('error-recovery');
    }

    return labels;
  }

  /**
   * Get the last N steps from the knowledge store
   *
   * @param n - Number of steps to retrieve
   * @param scope - Scope for step retrieval (current, all, or specific sessionId)
   * @param currentSessionId - Current session ID for scope resolution
   * @param filters - Optional filters to apply to steps
   * @returns Array of step summaries
   */
  async getLastSteps(
    n: number,
    scope: KnowledgeScope,
    currentSessionId: string | undefined,
    filters?: KnowledgeFilters,
  ): Promise<KnowledgeStepSummary[]> {
    const sessionIds = await this.resolveSessionIds(
      scope,
      currentSessionId,
      filters,
    );

    const allSteps: {
      /**
       * The step record
       */
      step: StepRecord;
      /**
       * Path to the step file
       */
      filepath: string;
    }[] = [];

    for (const sid of sessionIds) {
      const steps = await this.#loadSessionSteps(sid);
      for (const s of steps) {
        if (this.#stepMatchesFilters(s.step, filters)) {
          allSteps.push(s);
        }
      }
    }

    allSteps.sort(
      (a, b) =>
        new Date(b.step.timestamp).getTime() -
        new Date(a.step.timestamp).getTime(),
    );

    return allSteps.slice(0, n).map((item) => this.#summarizeStep(item.step));
  }

  /**
   * Search steps by query across sessions
   *
   * @param query - Search query string
   * @param limit - Maximum number of results to return
   * @param scope - Scope for search (current, all, or specific sessionId)
   * @param currentSessionId - Current session ID for scope resolution
   * @param filters - Optional filters to apply to steps
   * @returns Array of matching step summaries
   */
  async searchSteps(
    query: string,
    limit: number,
    scope: KnowledgeScope,
    currentSessionId: string | undefined,
    filters?: KnowledgeFilters,
  ): Promise<KnowledgeStepSummary[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const expandedTokens = expandWithSynonyms(queryTokens);

    const sessionIds = await this.resolveSessionIds(
      scope,
      currentSessionId,
      filters,
    );

    type ScoredSession = {
      sessionId: string;
      score: number;
      metadata?: SessionMetadata;
    };
    const scoredSessions: ScoredSession[] = [];

    for (const sid of sessionIds) {
      const metadata = await this.#readSessionMetadata(sid);
      const sessionScore = metadata
        ? this.#computeSessionScore(metadata, expandedTokens)
        : 0;
      scoredSessions.push({
        sessionId: sid,
        score: sessionScore,
        metadata: metadata ?? undefined,
      });
    }

    scoredSessions.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const aTime = a.metadata?.createdAt
        ? new Date(a.metadata.createdAt).getTime()
        : 0;
      const bTime = b.metadata?.createdAt
        ? new Date(b.metadata.createdAt).getTime()
        : 0;
      if (bTime !== aTime) {
        return bTime - aTime;
      }
      return a.sessionId.localeCompare(b.sessionId);
    });
    const topSessions = scoredSessions.slice(0, SCAN_LIMITS.maxSessionsToScan);

    type StepMatch = {
      step: StepRecord;
      score: number;
      sessionScore: number;
      sessionGoal?: string;
      matchedFields: string[];
    };
    const matches: StepMatch[] = [];
    let totalStepsScanned = 0;

    for (const {
      sessionId: sid,
      score: sessionScore,
      metadata,
    } of topSessions) {
      if (totalStepsScanned >= SCAN_LIMITS.maxTotalSteps) {
        break;
      }

      const steps = await this.#loadSessionSteps(sid);
      const limitedSteps = steps.slice(0, SCAN_LIMITS.maxStepsPerSession);
      totalStepsScanned += limitedSteps.length;

      for (const { step } of limitedSteps) {
        if (!this.#stepMatchesFilters(step, filters)) {
          continue;
        }

        const { score: stepScore, matchedFields } = this.#computeSearchScore(
          step,
          expandedTokens,
        );

        const combinedScore = sessionScore + stepScore;

        if (combinedScore > 0) {
          matches.push({
            step,
            score: combinedScore,
            sessionScore,
            sessionGoal: metadata?.goal,
            matchedFields,
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);

    return matches
      .slice(0, limit)
      .map((m) => this.#summarizeStep(m.step, m.matchedFields, m.sessionGoal));
  }

  /**
   * Check if a step matches the given filters
   *
   * @param step - Step record to check
   * @param filters - Filters to apply
   * @returns True if step matches all filters
   */
  #stepMatchesFilters(step: StepRecord, filters?: KnowledgeFilters): boolean {
    if (!filters) {
      return true;
    }

    if (
      filters.screen &&
      step.observation?.state?.currentScreen !== filters.screen
    ) {
      return false;
    }

    return true;
  }

  /**
   * Generate a recipe summary of steps in a session
   *
   * @param sessionId - Session ID to summarize
   * @returns Session summary with recipe steps
   */
  async summarizeSession(sessionId: string): Promise<{
    /**
     * Session ID
     */
    sessionId: string;
    /**
     * Total number of steps in session
     */
    stepCount: number;
    /**
     * Recipe steps describing the session flow
     */
    recipe: RecipeStep[];
  }> {
    const steps = await this.#loadSessionSteps(sessionId);

    steps.sort(
      (a, b) =>
        new Date(a.step.timestamp).getTime() -
        new Date(b.step.timestamp).getTime(),
    );

    const recipe: RecipeStep[] = steps.map(({ step }, index) => ({
      stepNumber: index + 1,
      tool: step.tool.name,
      notes: this.#generateStepNotes(step),
    }));

    return {
      sessionId,
      stepCount: steps.length,
      recipe,
    };
  }

  /**
   * Get all session IDs from the knowledge store
   *
   * @returns Array of all session IDs
   */
  async getAllSessionIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.#knowledgeRoot, {
        withFileTypes: true,
      });
      return entries
        .filter(
          (e) =>
            e.isDirectory() &&
            (e.name.startsWith('mm-') ||
              e.name.startsWith(this.#sessionIdPrefix)),
        )
        .map((e) => e.name);
    } catch (error) {
      debugWarn('knowledge-store.getAllSessionIds', error);
      return [];
    }
  }

  /**
   * Load all step records from a session
   *
   * @param sessionId - Session ID to load steps from
   * @returns Array of step records with file paths
   */
  async #loadSessionSteps(sessionId: string): Promise<
    {
      /**
       * The step record
       */
      step: StepRecord;
      /**
       * Path to the step file
       */
      filepath: string;
    }[]
  > {
    const stepsDir = path.join(this.#knowledgeRoot, sessionId, 'steps');

    try {
      const files = await fs.readdir(stepsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const steps: {
        /**
         * The step record
         */
        step: StepRecord;
        /**
         * Path to the step file
         */
        filepath: string;
      }[] = [];

      for (const file of jsonFiles) {
        const filepath = path.join(stepsDir, file);
        try {
          const content = await fs.readFile(filepath, 'utf-8');
          const step = JSON.parse(content) as StepRecord;
          steps.push({ step, filepath });
        } catch (error) {
          debugWarn('knowledge-store.loadSessionSteps', error);
          continue;
        }
      }

      return steps;
    } catch (error) {
      debugWarn('knowledge-store.loadSessionSteps', error);
      return [];
    }
  }

  /**
   * Sanitize tool input by redacting sensitive fields
   *
   * @param toolName - Name of the tool
   * @param input - Input parameters to sanitize
   * @returns Sanitized input with redaction metadata
   */
  #sanitizeInput(
    toolName: string,
    input?: Record<string, unknown>,
  ): {
    /**
     * Sanitized input parameters
     */
    input?: Record<string, unknown>;
    /**
     * Whether text was redacted
     */
    textRedacted?: boolean;
    /**
     * Length of redacted text
     */
    textLength?: number;
  } {
    if (!input) {
      return {};
    }

    const sanitized: Record<string, unknown> = {};
    let textRedacted = false;
    let textLength: number | undefined;

    const typeToolName = `${this.#toolPrefix}_type`;

    for (const [key, value] of Object.entries(input)) {
      if (toolName === typeToolName && key === 'text') {
        const textValue = String(value);
        const targetTestId = input.testId as string | undefined;
        const targetSelector = input.selector as string | undefined;

        const isSensitive =
          isSensitiveField(targetTestId ?? '') ||
          isSensitiveField(targetSelector ?? '') ||
          SENSITIVE_FIELD_PATTERNS.some((p: RegExp) => p.test(key));

        if (isSensitive) {
          textRedacted = true;
          textLength = textValue.length;
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = value;
        }
      } else if (isSensitiveField(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return {
      input: sanitized,
      textRedacted: textRedacted || undefined,
      textLength,
    };
  }

  /**
   * Get environment information
   *
   * @returns Environment details (platform and Node version)
   */
  #getEnvironmentInfo(): {
    /**
     * Operating system platform
     */
    platform: string;
    /**
     * Node.js version
     */
    nodeVersion: string;
  } {
    return {
      platform: process.platform,
      nodeVersion: process.version,
    };
  }

  /**
   * Create a summary of a step record
   *
   * @param step - Step record to summarize
   * @param matchedFields - Fields that matched the search query
   * @param sessionGoal - Goal of the session containing this step
   * @returns Step summary for display
   */
  #summarizeStep(
    step: StepRecord,
    matchedFields?: string[],
    sessionGoal?: string,
  ): KnowledgeStepSummary {
    const screen = step.observation?.state?.currentScreen ?? 'unknown';
    const snippet = this.#generateSnippet(step, matchedFields);

    return {
      timestamp: step.timestamp,
      tool: step.tool.name,
      screen,
      snippet,
      sessionId: step.sessionId,
      matchedFields: matchedFields?.length ? matchedFields : undefined,
      sessionGoal,
    };
  }

  /**
   * Generate a human-readable snippet from a step
   *
   * @param step - Step record to generate snippet from
   * @param matchedFields - Fields that matched the search query
   * @returns Human-readable snippet string
   */
  #generateSnippet(step: StepRecord, matchedFields?: string[]): string {
    const parts: string[] = [];

    if (matchedFields && matchedFields.length > 0) {
      const topMatches = matchedFields.slice(0, 3).join(', ');
      parts.push(`match: ${topMatches}`);
    }

    if (step.tool.target?.testId) {
      parts.push(`testId: ${step.tool.target.testId}`);
    } else if (step.tool.target?.a11yRef) {
      parts.push(`ref: ${step.tool.target.a11yRef}`);
    } else if (step.tool.target?.selector) {
      const shortSelector = step.tool.target.selector.substring(0, 30);
      parts.push(`selector: ${shortSelector}`);
    }

    if (step.labels && step.labels.length > 0) {
      parts.push(`labels: ${step.labels.join(', ')}`);
    }

    if (step.observation?.state?.currentScreen) {
      parts.push(`screen: ${step.observation.state.currentScreen}`);
    }

    if (!step.outcome.ok && step.outcome.error) {
      parts.push(`error: ${step.outcome.error.code}`);
    }

    return parts.join(', ') || step.tool.name;
  }

  /**
   * Generate notes describing a step
   *
   * @param step - Step record to generate notes from
   * @returns Notes string describing the step
   */
  #generateStepNotes(step: StepRecord): string {
    const notes: string[] = [];

    if (step.tool.target?.testId) {
      notes.push(`target: [data-testid="${step.tool.target.testId}"]`);
    } else if (step.tool.target?.a11yRef) {
      notes.push(`target: ${step.tool.target.a11yRef}`);
    }

    if (step.observation?.state?.currentScreen) {
      notes.push(`on screen: ${step.observation.state.currentScreen}`);
    }

    if (!step.outcome.ok && step.outcome.error) {
      notes.push(`FAILED: ${step.outcome.error.message}`);
    }

    if (step.artifacts?.screenshot?.path) {
      notes.push('screenshot captured');
    }

    return notes.join('; ') || 'executed';
  }

  /**
   * Compute relevance score for a session based on query tokens
   *
   * @param metadata - Session metadata to score
   * @param queryTokens - Tokens from the search query
   * @returns Relevance score for the session
   */
  #computeSessionScore(
    metadata: SessionMetadata,
    queryTokens: string[],
  ): number {
    let score = 0;

    for (const token of queryTokens) {
      for (const flowTag of metadata.flowTags) {
        if (flowTag.toLowerCase().includes(token)) {
          score += 12;
          break;
        }
      }
    }

    const goalTokens = tokenize(metadata.goal ?? '');
    for (const token of queryTokens) {
      if (goalTokens.includes(token)) {
        score += 6;
      }
    }

    for (const token of queryTokens) {
      for (const tag of metadata.tags) {
        if (tag.toLowerCase().includes(token)) {
          score += 4;
          break;
        }
      }
    }

    const ageHours =
      (Date.now() - new Date(metadata.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      score += 3;
    } else if (ageHours < 72) {
      score += 1;
    }

    return score;
  }

  /**
   * Compute relevance score for a step based on query tokens
   *
   * @param step - Step record to score
   * @param queryTokens - Tokens from the search query
   * @returns Score and matched field names
   */
  #computeSearchScore(
    step: StepRecord,
    queryTokens: string[],
  ): {
    /**
     * Relevance score for the step
     */
    score: number;
    /**
     * Fields that matched the query
     */
    matchedFields: string[];
  } {
    let score = 0;
    const matchedFieldsSet = new Set<string>();
    let matchedTokens = 0;

    const targetTestIdTokens = step.tool.target?.testId
      ? tokenizeIdentifier(step.tool.target.testId)
      : [];

    const observedTestIdTokensMap = new Map<string, string[]>();
    for (const testIdItem of step.observation?.testIds ?? []) {
      observedTestIdTokensMap.set(
        testIdItem.testId,
        tokenizeIdentifier(testIdItem.testId),
      );
    }

    for (const token of queryTokens) {
      let tokenMatched = false;

      if (step.tool.name.toLowerCase().includes(token)) {
        score += 10;
        matchedFieldsSet.add(`tool:${step.tool.name}`);
        tokenMatched = true;
      }

      const screen = step.observation?.state?.currentScreen;
      if (screen?.toLowerCase().includes(token)) {
        score += 8;
        matchedFieldsSet.add(`screen:${screen}`);
        tokenMatched = true;
      }

      if (step.tool.target?.testId && targetTestIdTokens.includes(token)) {
        score += 6;
        matchedFieldsSet.add(`testId:${step.tool.target.testId}`);
        tokenMatched = true;
      }

      for (const label of step.labels ?? []) {
        if (label.toLowerCase().includes(token)) {
          score += 5;
          matchedFieldsSet.add(`label:${label}`);
          tokenMatched = true;
          break;
        }
      }

      for (const [testId, tokens] of observedTestIdTokensMap) {
        if (tokens.includes(token)) {
          score += 3;
          matchedFieldsSet.add(`testId:${testId}`);
          tokenMatched = true;
          break;
        }
      }

      for (const node of step.observation?.a11y?.nodes ?? []) {
        if (node.name.toLowerCase().includes(token)) {
          score += 2;
          matchedFieldsSet.add(`a11y:${node.role}:"${node.name}"`);
          tokenMatched = true;
          break;
        }
        if (node.role.toLowerCase().includes(token)) {
          score += 2;
          matchedFieldsSet.add(`a11y:${node.role}`);
          tokenMatched = true;
          break;
        }
      }

      if (tokenMatched) {
        matchedTokens += 1;
      }
    }

    if (queryTokens.length > 0) {
      const coverageRatio = matchedTokens / queryTokens.length;
      score += Math.floor(coverageRatio * 5);
    }

    return { score, matchedFields: [...matchedFieldsSet] };
  }

  /**
   * Generate prior knowledge from historical sessions
   *
   * @param context - Current context for knowledge generation
   * @param currentSessionId - Current session ID to exclude from results
   * @returns Prior knowledge object or undefined if no relevant data found
   */
  async generatePriorKnowledge(
    context: PriorKnowledgeContext,
    currentSessionId?: string,
  ): Promise<PriorKnowledgeV1 | undefined> {
    const { windowHours } = PRIOR_KNOWLEDGE_CONFIG;

    const filters: KnowledgeFilters = {
      sinceHours: windowHours,
    };

    if (context.currentSessionFlowTags?.length) {
      filters.flowTag = context.currentSessionFlowTags[0];
    }

    const sessionIds = await this.resolveSessionIds('all', undefined, filters);
    const candidateSessionIds = sessionIds.filter(
      (sid) => sid !== currentSessionId,
    );

    if (candidateSessionIds.length === 0) {
      return undefined;
    }

    const relatedSessions = await this.#getRelatedSessions(
      candidateSessionIds,
      filters,
      PRIOR_KNOWLEDGE_CONFIG.maxRelatedSessions,
    );

    const { similarSteps, candidateStepCount } = await this.#getSimilarSteps(
      context,
      candidateSessionIds,
      filters,
    );

    const suggestedNextActions = this.#buildSuggestedActions(
      similarSteps,
      context,
    );

    const avoidList = await this.#buildAvoidList(context, candidateSessionIds);

    if (
      relatedSessions.length === 0 &&
      similarSteps.length === 0 &&
      suggestedNextActions.length === 0
    ) {
      return undefined;
    }

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      query: {
        windowHours,
        usedFlowTags: context.currentSessionFlowTags ?? [],
        usedFilters: filters,
        candidateSessions: candidateSessionIds.length,
        candidateSteps: candidateStepCount,
      },
      relatedSessions,
      similarSteps: similarSteps.slice(
        0,
        PRIOR_KNOWLEDGE_CONFIG.maxSimilarSteps,
      ),
      suggestedNextActions: suggestedNextActions.slice(
        0,
        PRIOR_KNOWLEDGE_CONFIG.maxSuggestedActions,
      ),
      avoid:
        avoidList.length > 0
          ? avoidList.slice(0, PRIOR_KNOWLEDGE_CONFIG.maxAvoid)
          : undefined,
    };
  }

  /**
   * Get related sessions based on filters
   *
   * @param sessionIds - Session IDs to filter
   * @param filters - Filters to apply
   * @param limit - Maximum number of sessions to return
   * @returns Array of related session summaries
   */
  async #getRelatedSessions(
    sessionIds: string[],
    filters: KnowledgeFilters,
    limit: number,
  ): Promise<PriorKnowledgeRelatedSession[]> {
    const sessions: PriorKnowledgeRelatedSession[] = [];

    for (const sid of sessionIds) {
      if (sessions.length >= limit) {
        break;
      }

      const metadata = await this.#readSessionMetadata(sid);
      if (!metadata) {
        continue;
      }

      if (!this.#matchesFilters(metadata, filters)) {
        continue;
      }

      sessions.push({
        sessionId: metadata.sessionId,
        createdAt: metadata.createdAt,
        goal: metadata.goal,
        flowTags: metadata.flowTags,
        tags: metadata.tags,
      });
    }

    return sessions;
  }

  /**
   * Find similar steps from historical sessions
   *
   * @param context - Current context for similarity matching
   * @param sessionIds - Session IDs to search
   * @param filters - Filters to apply to steps
   * @returns Similar steps and total candidate count
   */
  async #getSimilarSteps(
    context: PriorKnowledgeContext,
    sessionIds: string[],
    filters: KnowledgeFilters,
  ): Promise<{
    /**
     * Array of similar steps found
     */
    similarSteps: PriorKnowledgeSimilarStep[];
    /**
     * Total number of candidate steps scanned
     */
    candidateStepCount: number;
  }> {
    const scoredSteps: {
      /**
       * The step record
       */
      step: StepRecord;
      /**
       * Similarity score for the step
       */
      score: number;
    }[] = [];
    let candidateStepCount = 0;

    const visibleTestIdSet = new Set(
      context.visibleTestIds.map((t) => t.testId),
    );
    const visibleA11yNames = new Set(
      context.a11yNodes.map((n) => n.name.toLowerCase()),
    );

    const limitedSessionIds = sessionIds.slice(
      0,
      SCAN_LIMITS.maxSessionsToScan,
    );

    for (const sid of limitedSessionIds) {
      if (candidateStepCount >= SCAN_LIMITS.maxTotalSteps) {
        break;
      }

      const steps = await this.#loadSessionSteps(sid);
      const limitedSteps = steps.slice(0, SCAN_LIMITS.maxStepsPerSession);

      for (const { step } of limitedSteps) {
        candidateStepCount += 1;

        if (!this.#stepMatchesFilters(step, filters)) {
          continue;
        }

        if (this.#discoveryTools.includes(step.tool.name)) {
          continue;
        }

        const score = this.#computeSimilarityScore(
          step,
          context,
          visibleTestIdSet,
          visibleA11yNames,
        );

        if (score > 0) {
          scoredSteps.push({ step, score });
        }
      }
    }

    scoredSteps.sort((a, b) => b.score - a.score);

    const similarSteps: PriorKnowledgeSimilarStep[] = scoredSteps
      .slice(0, PRIOR_KNOWLEDGE_CONFIG.maxSimilarSteps)
      .map(({ step, score }) => {
        const a11yHint = this.#lookupA11yHint(step);

        return {
          sessionId: step.sessionId,
          timestamp: step.timestamp,
          tool: step.tool.name,
          screen: step.observation?.state?.currentScreen ?? 'unknown',
          snippet: this.#generateSnippet(step),
          labels: step.labels,
          target: step.tool.target
            ? {
                testId: step.tool.target.testId,
                selector: step.tool.target.selector,
              }
            : undefined,
          a11yHint,
          confidence: Math.min(score / MAX_SIMILARITY_SCORE, 1),
        };
      });

    return { similarSteps, candidateStepCount };
  }

  /**
   * Look up accessibility hint for a step's target
   *
   * @param step - Step record to look up hint for
   * @returns Accessibility hint with role and name, or undefined
   */
  #lookupA11yHint(step: StepRecord):
    | {
        /**
         * ARIA role of the element
         */
        role: string;
        /**
         * Accessible name of the element
         */
        name: string;
      }
    | undefined {
    const a11yRef = step.tool.target?.a11yRef;
    if (!a11yRef) {
      return undefined;
    }

    const nodes = step.observation?.a11y?.nodes ?? [];
    const matchingNode = nodes.find((node) => node.ref === a11yRef);
    if (!matchingNode?.name) {
      return undefined;
    }

    return { role: matchingNode.role, name: matchingNode.name };
  }

  /**
   * Compute similarity score between a step and current context
   *
   * @param step - Step record to score
   * @param context - Current context for comparison
   * @param visibleTestIdSet - Set of visible test IDs in current context
   * @param visibleA11yNames - Set of visible accessibility names in current context
   * @returns Similarity score
   */
  #computeSimilarityScore(
    step: StepRecord,
    context: PriorKnowledgeContext,
    visibleTestIdSet: Set<string>,
    visibleA11yNames: Set<string>,
  ): number {
    let score = 0;

    const stepScreen = step.observation?.state?.currentScreen;
    const contextScreen = context.currentScreen;

    if (stepScreen === contextScreen && stepScreen !== 'unknown') {
      score += SIMILARITY_WEIGHTS.sameScreen;
    }

    if (context.currentUrl && step.observation?.state) {
      const currentPathTokens = extractPathTokens(context.currentUrl);
      const stepUrl = step.observation.state.currentUrl ?? '';
      const stepPathTokens = extractPathTokens(stepUrl);

      for (const token of currentPathTokens) {
        if (stepPathTokens.includes(token)) {
          score += SIMILARITY_WEIGHTS.urlPathOverlap;
          break;
        }
      }
    }

    let testIdOverlapCount = 0;
    for (const testId of step.observation?.testIds ?? []) {
      if (visibleTestIdSet.has(testId.testId)) {
        testIdOverlapCount += 1;
        if (testIdOverlapCount >= 3) {
          break;
        }
      }
    }
    score += Math.min(testIdOverlapCount, 3) * SIMILARITY_WEIGHTS.testIdOverlap;

    let a11yOverlapCount = 0;
    for (const node of step.observation?.a11y?.nodes ?? []) {
      if (visibleA11yNames.has(node.name.toLowerCase())) {
        a11yOverlapCount += 1;
        if (a11yOverlapCount >= 2) {
          break;
        }
      }
    }
    score += Math.min(a11yOverlapCount, 2) * SIMILARITY_WEIGHTS.a11yOverlap;

    if (this.#actionableTools.includes(step.tool.name)) {
      score += SIMILARITY_WEIGHTS.actionableTool;
    }

    return score;
  }

  /**
   * Build suggested actions from similar steps
   *
   * @param similarSteps - Similar steps to analyze
   * @param context - Current context for action building
   * @returns Array of suggested actions
   */
  #buildSuggestedActions(
    similarSteps: PriorKnowledgeSimilarStep[],
    context: PriorKnowledgeContext,
  ): PriorKnowledgeSuggestedAction[] {
    const visibleTestIdSet = new Set(
      context.visibleTestIds.map((t) => t.testId),
    );
    const visibleA11yMap = new Map(
      context.a11yNodes.map((n) => [n.name.toLowerCase(), n]),
    );

    const actionCounts = new Map<
      string,
      {
        step: PriorKnowledgeSimilarStep;
        count: number;
        confidenceSum: number;
      }
    >();

    for (const step of similarSteps) {
      if (!step.target?.testId && !step.target?.selector) {
        continue;
      }

      const key = step.target.testId ?? step.target.selector ?? '';

      const existing = actionCounts.get(key);
      if (existing) {
        existing.count += 1;
        existing.confidenceSum += step.confidence;
      } else {
        actionCounts.set(key, {
          step,
          count: 1,
          confidenceSum: step.confidence,
        });
      }
    }

    const suggestions: PriorKnowledgeSuggestedAction[] = [];

    const sortedActions = Array.from(actionCounts.entries()).sort(
      ([, a], [, b]) => b.confidenceSum - a.confidenceSum,
    );

    for (const [, { step, count, confidenceSum }] of sortedActions) {
      if (suggestions.length >= PRIOR_KNOWLEDGE_CONFIG.maxSuggestedActions) {
        break;
      }

      const preferredTarget = this.#buildPreferredTarget(
        step,
        visibleTestIdSet,
      );
      if (!preferredTarget) {
        continue;
      }

      const fallbackTargets = this.#buildFallbackTargets(
        preferredTarget,
        visibleA11yMap,
      );

      const action = this.#toolToAction(step.tool);
      if (!action) {
        continue;
      }

      suggestions.push({
        rank: suggestions.length + 1,
        action,
        rationale:
          count > 1
            ? `Used ${count} times successfully on this screen`
            : 'Most common next successful step on this screen',
        confidence: Math.min(confidenceSum / count, 1),
        preferredTarget,
        fallbackTargets:
          fallbackTargets.length > 0 ? fallbackTargets : undefined,
      });
    }

    return suggestions;
  }

  /**
   * Build preferred target from a prior step
   *
   * @param priorStep - Prior step to extract target from
   * @param visibleTestIdSet - Set of visible test IDs in current context
   * @returns Preferred target or null if none found
   */
  #buildPreferredTarget(
    priorStep: PriorKnowledgeSimilarStep,
    visibleTestIdSet: Set<string>,
  ): PriorKnowledgeTarget | null {
    if (
      priorStep.target?.testId &&
      visibleTestIdSet.has(priorStep.target.testId)
    ) {
      return { type: 'testId', value: priorStep.target.testId };
    }

    if (priorStep.target?.selector) {
      return { type: 'selector', value: priorStep.target.selector };
    }

    if (priorStep.a11yHint) {
      return { type: 'a11yHint', value: priorStep.a11yHint };
    }

    return null;
  }

  /**
   * Build fallback targets for a preferred target
   *
   * @param preferredTarget - Preferred target to find fallbacks for
   * @param visibleA11yMap - Map of visible accessibility nodes
   * @returns Array of fallback targets
   */
  #buildFallbackTargets(
    preferredTarget: PriorKnowledgeTarget,
    visibleA11yMap: Map<string, A11yNodeTrimmed>,
  ): PriorKnowledgeTarget[] {
    const fallbacks: PriorKnowledgeTarget[] = [];

    if (preferredTarget.type === 'testId') {
      const testId = preferredTarget.value;

      const entries = Array.from(visibleA11yMap.entries());
      for (const [name, node] of entries) {
        if (
          name.includes(testId.replace(/-/gu, ' ').toLowerCase()) ||
          testId.toLowerCase().includes(name)
        ) {
          fallbacks.push({
            type: 'a11yHint',
            value: { role: node.role, name: node.name },
          });
          break;
        }
      }
    }

    return fallbacks;
  }

  /**
   * Convert tool name to action type
   *
   * @param toolName - Tool name to convert
   * @returns Action type or null if not found
   */
  #toolToAction(
    toolName: string,
  ): PriorKnowledgeSuggestedAction['action'] | null {
    return this.#toolActionMap[toolName] ?? null;
  }

  /**
   * Build list of actions to avoid based on failure history
   *
   * @param context - Current context for avoid list building
   * @param sessionIds - Session IDs to analyze for failures
   * @returns Array of actions to avoid
   */
  async #buildAvoidList(
    context: PriorKnowledgeContext,
    sessionIds: string[],
  ): Promise<PriorKnowledgeAvoid[]> {
    const failureCounts = new Map<
      string,
      {
        /**
         * Error code from the failure
         */
        errorCode?: string;
        /**
         * CSS selector of the failed target
         */
        selector?: string;
        /**
         * Test ID of the failed target
         */
        testId?: string;
        /**
         * Number of times this target failed
         */
        count: number;
      }
    >();

    for (const sid of sessionIds) {
      const steps = await this.#loadSessionSteps(sid);

      for (const { step } of steps) {
        if (step.outcome.ok) {
          continue;
        }
        if (step.observation?.state?.currentScreen !== context.currentScreen) {
          continue;
        }

        const targetKey =
          step.tool.target?.testId ?? step.tool.target?.selector ?? 'unknown';

        const existing = failureCounts.get(targetKey);
        if (existing) {
          existing.count += 1;
        } else {
          failureCounts.set(targetKey, {
            errorCode: step.outcome.error?.code,
            testId: step.tool.target?.testId,
            selector: step.tool.target?.selector,
            count: 1,
          });
        }
      }
    }

    const avoidList: PriorKnowledgeAvoid[] = [];

    const failureEntries = Array.from(failureCounts.values());
    for (const failure of failureEntries) {
      if (failure.count < PRIOR_KNOWLEDGE_CONFIG.minAvoidFailureCount) {
        continue;
      }

      avoidList.push({
        rationale: 'Frequently fails due to UI churn',
        target: {
          testId: failure.testId,
          selector: failure.selector,
        },
        errorCode: failure.errorCode,
        frequency: failure.count,
      });
    }

    avoidList.sort((a, b) => b.frequency - a.frequency);

    return avoidList;
  }
}

/**
 * Create a default observation object with state and optional artifacts
 *
 * @param state - Extension state snapshot
 * @param testIds - Array of visible test IDs
 * @param a11yNodes - Array of accessibility nodes
 * @param priorKnowledge - Optional prior knowledge from history
 * @returns Observation object for step recording
 */
export function createDefaultObservation(
  state: ExtensionState,
  testIds: TestIdItem[] = [],
  a11yNodes: A11yNodeTrimmed[] = [],
  priorKnowledge?: PriorKnowledgeV1,
): StepRecordObservation {
  const observation: StepRecordObservation = {
    state,
    testIds,
    a11y: { nodes: a11yNodes },
  };

  if (priorKnowledge) {
    observation.priorKnowledge = priorKnowledge;
  }

  return observation;
}

/**
 * Create a new KnowledgeStore instance
 *
 * @param config - Optional configuration for the store
 * @returns New KnowledgeStore instance
 */
export function createKnowledgeStore(
  config?: KnowledgeStoreConfig,
): KnowledgeStore {
  return new KnowledgeStore(config);
}

let _knowledgeStore: KnowledgeStore | undefined;

/**
 * Set the global knowledge store instance
 *
 * @param store - KnowledgeStore instance to set as global
 */
export function setKnowledgeStore(store: KnowledgeStore): void {
  _knowledgeStore = store;
}

/**
 * Get the global knowledge store instance
 *
 * @returns The global KnowledgeStore instance
 */
export function getKnowledgeStore(): KnowledgeStore {
  if (!_knowledgeStore) {
    throw new Error(
      'Knowledge store not initialized. Call setKnowledgeStore() first.',
    );
  }
  return _knowledgeStore;
}

/**
 * Check if a knowledge store has been initialized
 *
 * @returns True if knowledge store is initialized
 */
export function hasKnowledgeStore(): boolean {
  return _knowledgeStore !== undefined;
}

export const knowledgeStore = {
  /**
   * Record a tool execution step
   *
   * @param params - Step recording parameters
   * @returns Path to the recorded step file
   */
  recordStep: async (params: Parameters<KnowledgeStore['recordStep']>[0]) => {
    return getKnowledgeStore().recordStep(params);
  },
  /**
   * Get the last N steps from the knowledge store
   *
   * @param args - Arguments for getLastSteps
   * @returns Array of step summaries
   */
  getLastSteps: async (...args: Parameters<KnowledgeStore['getLastSteps']>) => {
    return getKnowledgeStore().getLastSteps(...args);
  },
  /**
   * Search steps by query
   *
   * @param args - Arguments for searchSteps
   * @returns Array of matching step summaries
   */
  searchSteps: async (...args: Parameters<KnowledgeStore['searchSteps']>) => {
    return getKnowledgeStore().searchSteps(...args);
  },
  /**
   * Generate a recipe summary of a session
   *
   * @param args - Arguments for summarizeSession
   * @returns Session summary with recipe steps
   */
  summarizeSession: async (
    ...args: Parameters<KnowledgeStore['summarizeSession']>
  ) => {
    return getKnowledgeStore().summarizeSession(...args);
  },
  /**
   * List sessions with optional filtering
   *
   * @param args - Arguments for listSessions
   * @returns Array of session summaries
   */
  listSessions: async (...args: Parameters<KnowledgeStore['listSessions']>) => {
    return getKnowledgeStore().listSessions(...args);
  },
  /**
   * Generate prior knowledge from historical sessions
   *
   * @param args - Arguments for generatePriorKnowledge
   * @returns Prior knowledge object or undefined
   */
  generatePriorKnowledge: async (
    ...args: Parameters<KnowledgeStore['generatePriorKnowledge']>
  ) => {
    return getKnowledgeStore().generatePriorKnowledge(...args);
  },
  /**
   * Write session metadata to disk
   *
   * @param metadata - Session metadata to persist
   * @returns Path to the written metadata file
   */
  writeSessionMetadata: async (metadata: SessionMetadata) => {
    return getKnowledgeStore().writeSessionMetadata(metadata);
  },
};
