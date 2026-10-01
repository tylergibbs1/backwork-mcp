/**
 * Checks the MCP server's operation catalog (src/api-operations.ts) against a
 * Backwork OpenAPI document. Returns a list of problems; empty means in sync.
 */

const AVAILABILITY_KEY = "x-backwork-availability";
const SCOPES_KEY = "x-backwork-required-scopes";
const UNAVAILABLE = "unavailable-in-production";
const PRODUCTION_API_BASE = "https://backworkhealth.com/api/v1";
// Prose the platform may reword without changing the contract.
const PROSE_KEYS = new Set(["description", "summary", "example", "examples"]);

function resolve(spec, schema) {
  let current = schema;
  const seen = new Set();
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) break;
    seen.add(current.$ref);
    const name = current.$ref.replace("#/components/schemas/", "");
    current = spec.components?.schemas?.[name];
  }
  return current;
}

/** Every concrete schema a value could match: unions and intersections are flattened. */
function branches(spec, schema) {
  const resolved = resolve(spec, schema);
  if (!resolved || typeof resolved !== "object") return [];
  const nested = [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? []), ...(resolved.allOf ?? [])];
  if (nested.length === 0) return [resolved];
  return [resolved, ...nested.flatMap((branch) => branches(spec, branch))];
}

function segmentsOf(path) {
  return path.split(".").flatMap((part) => {
    if (part === "[]") return ["[]"];
    if (part.endsWith("[]")) return [part.slice(0, -2), "[]"];
    return [part];
  });
}

/** True when some branch of `schema` declares the dot path. */
function hasPath(spec, schema, segments) {
  if (segments.length === 0) return true;
  const [head, ...rest] = segments;
  return branches(spec, schema).some((branch) => {
    if (head === "[]") return branch.items !== undefined && hasPath(spec, branch.items, rest);
    if (head === "*") {
      const values = branch.additionalProperties;
      return values !== undefined && values !== false && (rest.length === 0 || (typeof values === "object" && hasPath(spec, values, rest)));
    }
    const property = branch.properties?.[head];
    if (property !== undefined) return hasPath(spec, property, rest);
    // A free-form object (record) can carry any key, but then nothing below it is declared.
    const additional = branch.additionalProperties;
    return rest.length === 0 && additional !== undefined && additional !== false;
  });
}

/** The schemas of `part` ("data" or "meta") across the operation's success responses. */
function successSchemas(spec, operation, part) {
  const success = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
  return success
    .map(([, response]) => resolve(spec, response)?.content?.["application/json"]?.schema)
    .filter(Boolean)
    .map((schema) => branches(spec, schema).find((branch) => branch.properties?.[part])?.properties[part])
    .filter(Boolean);
}

function operationIn(spec, entry) {
  return spec.paths?.[entry.path]?.[entry.method.toLowerCase()];
}

function scopeIn(operation) {
  return (operation[SCOPES_KEY] ?? []).includes("write") ? "write" : "read";
}

/**
 * Every problem is drift: the catalog must mirror each request field, read
 * field, availability marker and required scope of the operations it calls.
 *
 * @param {object} spec OpenAPI document
 * @param {Record<string, import("../build/src/api-operations.js").BackworkOperation>} catalog
 */
export function checkContract(spec, catalog) {
  const problems = [];

  for (const [id, entry] of Object.entries(catalog)) {
    const where = `${id} (${entry.method} ${entry.path})`;
    const operation = operationIn(spec, entry);
    if (!operation) {
      problems.push(`${where}: operation is not in the OpenAPI document`);
      continue;
    }

    const parameters = (operation.parameters ?? []).map((parameter) => resolve(spec, parameter));
    const declared = (location) =>
      new Set(parameters.filter((p) => p.in === location).map((p) => (location === "header" ? p.name.toLowerCase() : p.name)));

    const pathNames = [...entry.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const name of pathNames) {
      if (!declared("path").has(name)) problems.push(`${where}: path parameter "${name}" is not declared`);
    }
    for (const name of entry.query) {
      if (!declared("query").has(name)) problems.push(`${where}: query parameter "${name}" is not accepted`);
    }
    for (const name of entry.headers) {
      if (!declared("header").has(name.toLowerCase())) problems.push(`${where}: header "${name}" is not accepted`);
    }

    const bodySchema = operation.requestBody
      ? resolve(spec, operation.requestBody)?.content?.["application/json"]?.schema
      : undefined;
    if (entry.body.length > 0 && !bodySchema) problems.push(`${where}: sends a body but the operation declares none`);
    for (const name of entry.body) {
      if (bodySchema && !hasPath(spec, bodySchema, [name])) problems.push(`${where}: body field "${name}" is not accepted`);
    }

    for (const [part, reads] of [
      ["data", [...entry.reads, ...entry.readsForWriteAccess]],
      ["meta", entry.metaReads],
    ]) {
      const schemas = successSchemas(spec, operation, part);
      for (const read of reads) {
        if (!schemas.some((schema) => hasPath(spec, schema, segmentsOf(read)))) {
          problems.push(`${where}: reads ${part}.${read}, which the success response does not declare`);
        }
      }
    }

    const marker = operation[AVAILABILITY_KEY] === UNAVAILABLE ? UNAVAILABLE : "available";
    if (marker !== entry.availability) {
      problems.push(`${where}: catalog availability is "${entry.availability}" but the document says "${marker}"`);
    }
    if (scopeIn(operation) !== entry.scope) {
      problems.push(`${where}: catalog scope is "${entry.scope}" but the document requires "${scopeIn(operation)}"`);
    }
  }

  return problems;
}

/**
 * Asks the server's own exposure rule which tool actions it offers against the
 * production API, for a read-only OAuth grant and for a write-scoped API key,
 * and fails for any offered action whose operation the document does not serve
 * to that credential. This holds even if the catalog itself is stale.
 *
 * @param {object} spec OpenAPI document
 * @param {Record<string, import("../build/src/api-operations.js").BackworkOperation>} catalog
 * @param {Record<string, Record<string, readonly string[]>>} toolOperations
 * @param {typeof import("../build/src/api-operations.js").operationExposure} operationExposure
 */
export function checkExposure(spec, catalog, toolOperations, operationExposure) {
  const problems = [];
  for (const access of ["read", "write"]) {
    const context = { apiBase: PRODUCTION_API_BASE, access, exposeUnavailable: false };
    for (const [tool, actions] of Object.entries(toolOperations)) {
      for (const [action, ids] of Object.entries(actions)) {
        if (ids.some((id) => operationExposure(catalog[id], context) !== "offered")) continue;
        for (const id of ids) {
          const where = `backwork_${tool} '${action}' (${access} access) calls ${id}`;
          const operation = operationIn(spec, catalog[id]);
          if (!operation) problems.push(`${where}, which production does not serve`);
          else if (operation[AVAILABILITY_KEY] === UNAVAILABLE) problems.push(`${where}, which production marks unavailable`);
          else if (access === "read" && scopeIn(operation) === "write") problems.push(`${where}, which needs write scope`);
        }
      }
    }
  }
  return problems;
}

function withoutProse(value) {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PROSE_KEYS.has(key))
      .map(([key, child]) => [key, withoutProse(child)]),
  );
}

function differences(a, b, pointer, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const bothObjects = a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    out.push(pointer || "/");
    return;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    differences(a[key], b[key], `${pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`, out);
  }
}

/** JSON pointers where two OpenAPI documents disagree, ignoring descriptions, summaries and examples. */
export function specDifferences(vendored, published) {
  const out = [];
  differences(withoutProse(vendored), withoutProse(published), "", out);
  return out;
}
