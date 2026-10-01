import { BACKWORK_OPERATIONS, type OperationId, type Scope } from "./api-operations.js";

/**
 * Response projection: a tool result carries only the response fields the
 * operation catalog lists in `reads` (under `data`) and `metaReads` (under
 * `meta`). Anything else the API returns, such as request IDs, timestamps,
 * job cost, polling URLs or model names, is dropped before a tool sees it
 * (response minimization in https://developers.openai.com/plugins/plugin-guidelines#tool-data-handling).
 *
 * A path is dot-separated; `[]` steps into array items and `*` into every
 * value of a keyed record. The last segment keeps its whole value.
 */

/** `true` keeps the whole value; an object keeps only its listed keys. */
type ReadTree = true | { readonly [segment: string]: ReadTree };

export function pathSegments(path: string): string[] {
  return path.split(".").flatMap((part) => {
    if (part === "[]") return ["[]"];
    if (part.endsWith("[]")) return [part.slice(0, -2), "[]"];
    return [part];
  });
}

function compile(paths: readonly string[]): ReadTree {
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    let node = root;
    const segments = pathSegments(path);
    segments.forEach((segment, index) => {
      if (node[segment] === true) return;
      if (index === segments.length - 1) {
        node[segment] = true;
        return;
      }
      node[segment] ??= {};
      node = node[segment] as Record<string, unknown>;
    });
  }
  return root as ReadTree;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps the parts of `value` the tree names. An array or record where the tree expects the other shape is dropped. */
function project(value: unknown, tree: ReadTree): unknown {
  if (tree === true || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = tree["[]"];
    return items ? value.map((item) => project(item, items)) : undefined;
  }
  if (tree["[]"] && Object.keys(tree).length === 1) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const subtree = key === "[]" || key === "*" ? undefined : (tree[key] ?? tree["*"]);
    if (!subtree) continue;
    const projected = project(child, subtree);
    if (projected !== undefined) kept[key] = projected;
  }
  return kept;
}

const compiled = new Map<string, ReadTree>();

function treeFor(operationId: OperationId, part: "data" | "meta", access: Scope): ReadTree {
  const key = `${operationId}:${part}:${access}`;
  let tree = compiled.get(key);
  if (!tree) {
    const operation = BACKWORK_OPERATIONS[operationId];
    const paths =
      part === "meta"
        ? operation.metaReads
        : [...operation.reads, ...(access === "write" ? operation.readsForWriteAccess : [])];
    tree = compile(paths);
    compiled.set(key, tree);
  }
  return tree;
}

/**
 * The success envelope a tool may see: `data` and `meta` reduced to the
 * catalog's listed paths. `readsForWriteAccess` paths (IDs that only a write
 * action uses) are kept only for a credential with write access.
 */
export function projectEnvelope(operationId: OperationId, envelope: unknown, access: Scope): { data: unknown; meta: unknown } {
  const body = isRecord(envelope) ? envelope : {};
  return {
    data: project(body.data, treeFor(operationId, "data", access)),
    meta: isRecord(body.meta) ? project(body.meta, treeFor(operationId, "meta", access)) : undefined,
  };
}
