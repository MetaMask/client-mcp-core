import type { Page, Locator } from "@playwright/test";
import type {
  TestIdItem,
  A11yNodeTrimmed,
  RawA11yNode,
  IncludedRole,
} from "./types/index.js";
import { INCLUDED_ROLES } from "./types/index.js";
import { TEXT_PREVIEW_MAX_LENGTH } from "./constants.js";
import { debugWarn } from "./utils/index.js";

const INCLUDED_ROLES_SET = new Set<string>(INCLUDED_ROLES);

export async function collectTestIds(
  page: Page,
  limit: number = 150,
): Promise<TestIdItem[]> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  const locators = await page.locator("[data-testid]").all();
  const results: TestIdItem[] = [];

  for (const locator of locators) {
    if (results.length >= limit) {
      break;
    }

    try {
      const testId = await locator.getAttribute("data-testid");
      if (!testId) {
        continue;
      }

       const isVisible = await locator.isVisible().catch(() => false);
       const textContent = await locator
         .textContent()
         .then((text) => text?.trim().substring(0, TEXT_PREVIEW_MAX_LENGTH) || undefined)
         .catch(() => undefined);

       results.push({
         testId,
         tag: "element",
         text: textContent,
         visible: isVisible,
       });
     } catch (error) {
       debugWarn("discovery.collectTestIds", error);
       continue;
     }
  }

  return results;
}

export async function collectTrimmedA11ySnapshot(
  page: Page,
  rootSelector?: string,
): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
  let snapshotRoot: RawA11yNode | null;

  if (rootSelector) {
    const locator = page.locator(rootSelector).first();
    snapshotRoot =
      (await locator.ariaSnapshot()) as unknown as RawA11yNode | null;
  } else {
    const bodyLocator = page.locator("body").first();
    snapshotRoot =
      (await bodyLocator.ariaSnapshot()) as unknown as RawA11yNode | null;
  }

  if (!snapshotRoot) {
    return { nodes: [], refMap: new Map() };
  }

  const trimmedNodes: A11yNodeTrimmed[] = [];
  const refMap = new Map<string, string>();
  let refCounter = 1;

  function traverseNode(node: RawA11yNode, ancestorPath: string[]): void {
    const role = node.role?.toLowerCase() ?? "";
    const name = node.name ?? "";

    if (INCLUDED_ROLES_SET.has(role)) {
      const ref = `e${refCounter}`;
      refCounter += 1;
      const currentPath = [...ancestorPath];

      if (role === "dialog" || role === "heading") {
        currentPath.push(`${role}:${name}`);
      }

      const trimmedNode: A11yNodeTrimmed = {
        ref,
        role,
        name,
        path: currentPath,
      };

      if (node.disabled !== undefined) {
        trimmedNode.disabled = node.disabled;
      }
      if (node.checked !== undefined) {
        trimmedNode.checked = node.checked === true;
      }
      if (node.expanded !== undefined) {
        trimmedNode.expanded = node.expanded;
      }

      trimmedNodes.push(trimmedNode);

      const selector = buildA11ySelector(role as IncludedRole, name);
      refMap.set(ref, selector);
    }

    const updatedPath =
      role === "dialog" || role === "heading"
        ? [...ancestorPath, `${role}:${name}`]
        : ancestorPath;

    if (node.children) {
      for (const child of node.children) {
        traverseNode(child, updatedPath);
      }
    }
  }

  traverseNode(snapshotRoot, []);

  return { nodes: trimmedNodes, refMap };
}

function buildA11ySelector(role: IncludedRole, name: string): string {
  const escapedName = name.replace(/"/gu, '\\"');
  return `role=${role}[name="${escapedName}"]`;
}

export async function resolveTarget(
  page: Page,
  targetType: "a11yRef" | "testId" | "selector",
  targetValue: string,
  refMap: Map<string, string>,
): Promise<Locator> {
  switch (targetType) {
    case "a11yRef": {
      const selector = refMap.get(targetValue);
      if (!selector) {
        throw new Error(
          `Unknown a11yRef: ${targetValue}. ` +
            `Available refs: ${Array.from(refMap.keys()).join(", ")}`,
        );
      }
      return page.locator(selector);
    }
    case "testId":
      return page.locator(`[data-testid="${targetValue}"]`);
    case "selector":
      return page.locator(targetValue);
    default: {
      const exhaustiveCheck: never = targetType;
      throw new Error(`Unknown target type: ${exhaustiveCheck as string}`);
    }
  }
}

export async function waitForTarget(
  page: Page,
  targetType: "a11yRef" | "testId" | "selector",
  targetValue: string,
  refMap: Map<string, string>,
  timeoutMs: number,
): Promise<Locator> {
  const locator = await resolveTarget(page, targetType, targetValue, refMap);
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  return locator;
}
