import { execFile as execFileCb } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SnapshotNode } from './types.js';

const execFile = promisify(execFileCb);

const AXSNAPSHOT_TIMEOUT_MS = 15_000;

type AXFrame = { x: number; y: number; width: number; height: number };

type AXTreeNode = {
  role?: string;
  subrole?: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame?: AXFrame;
  children?: AXTreeNode[];
};

type AXSnapshotPayload = {
  root?: AXTreeNode;
  windowFrame?: AXFrame | null;
};

export async function snapshotAxIos(): Promise<SnapshotNode[]> {
  const binaryPath = await resolveAxSnapshotBinaryPath();
  const { stdout, stderr } = await execFile(binaryPath, [], {
    timeout: AXSNAPSHOT_TIMEOUT_MS,
  });

  const stderrText = String(stderr ?? '').trim();
  if (stderrText.length > 0) {
    if (stderrText.toLowerCase().includes('accessibility permission')) {
      throw new Error(`MM_IOS_AX_PERMISSION_REQUIRED: ${stderrText}`);
    }
    throw new Error(`MM_IOS_AX_SNAPSHOT_FAILED: ${stderrText}`);
  }

  const parsed = parsePayload(String(stdout ?? ''));
  return mapAxToSnapshotNodes(parsed.root, parsed.windowFrame ?? undefined);
}

async function resolveAxSnapshotBinaryPath(): Promise<string> {
  const envPath = process.env.METAMASK_AXSNAPSHOT_BINARY;
  if (envPath && (await existsExecutable(envPath))) {
    return envPath;
  }

  const packaged = path.resolve(
    process.cwd(),
    'node_modules',
    '@metamask',
    'client-mcp-core',
    'dist',
    'bin',
    'axsnapshot',
  );
  if (await existsExecutable(packaged)) {
    return packaged;
  }

  throw new Error(
    'MM_IOS_AX_BINARY_MISSING: AXSnapshot binary not found. Run build:axsnapshot or set METAMASK_AXSNAPSHOT_BINARY.',
  );
}

async function existsExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parsePayload(stdoutText: string): AXSnapshotPayload {
  const text = stdoutText.trim();
  if (!text) {
    throw new Error('AXSnapshot returned empty output');
  }

  const parsed = JSON.parse(text) as AXSnapshotPayload | AXTreeNode;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AXSnapshot returned invalid JSON');
  }

  if ('root' in parsed) {
    if (!parsed.root) {
      throw new Error('AXSnapshot payload missing root');
    }
    return parsed;
  }

  return {
    root: parsed as AXTreeNode,
    windowFrame: null,
  };
}

function mapAxToSnapshotNodes(
  root: AXTreeNode | undefined,
  windowFrame?: AXFrame,
): SnapshotNode[] {
  if (!root) {
    return [];
  }

  let index = 0;

  const mapNode = (node: AXTreeNode): SnapshotNode => {
    const rect = normalizeFrame(node.frame, windowFrame);
    const mapped: SnapshotNode = {
      index: index++,
      type: node.subrole ?? node.role ?? 'Element',
      label: node.label,
      value: node.value,
      identifier: node.identifier,
      rect,
      enabled: true,
      hittable: true,
      children: [],
    };

    const children = node.children?.map((child) => mapNode(child)) ?? [];
    mapped.children = children;
    return mapped;
  };

  return [mapNode(root)];
}

function normalizeFrame(frame?: AXFrame, windowFrame?: AXFrame) {
  if (!frame) {
    return undefined;
  }

  if (!windowFrame) {
    return {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    };
  }

  return {
    x: frame.x - windowFrame.x,
    y: frame.y - windowFrame.y,
    width: frame.width,
    height: frame.height,
  };
}
