/**
 * Checks the MCP server's operation catalog (src/api-operations.ts) against a
 * Backwork OpenAPI document. Returns a list of problems; empty means in sync.
 */

const AVAILABILITY_KEY = "x-backwork-availability";
const UNAVAILABLE = "unavailable-in-production";

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
    const property = branch.properties?.[head];
    if (property !== undefined) return hasPath(spec, property, rest);
    // A free-form object (record) can carry any key, but then nothing below it is declared.
    const additional = branch.additionalProperties;
    return rest.length === 0 && additional !== undefined && additional !== false;
  });
}

function successDataSchema(spec, operation) {
  const success = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
  return success
    .map(([, response]) => resolve(spec, response)?.content?.["application/json"]?.schema)
    .filter(Boolean)
    .map((schema) => branches(spec, schema).find((branch) => branch.properties?.data)?.properties.data)
    .filter(Boolean);
}

/**
 * @param {object} spec OpenAPI document
 * @param {Record<string, import("../build/src/api-operations.js").BackworkOperation>} catalog
 * @param {{ availability: "exact" | "no-silent-failures" }} options
 *   "exact" requires the catalog to mirror every marker. "no-silent-failures"
 *   only fails when the document marks an operation unavailable that the
 *   catalog still treats as available; the reverse is reported as a warning.
 */
export function checkContract(spec, catalog, options = { availability: "exact" }) {
  const problems = [];
  const warnings = [];

  for (const [id, entry] of Object.entries(catalog)) {
    const where = `${id} (${entry.method} ${entry.path})`;
    const operation = spec.paths?.[entry.path]?.[entry.method.toLowerCase()];
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

    const dataSchemas = successDataSchema(spec, operation);
    for (const read of entry.reads) {
      if (!dataSchemas.some((schema) => hasPath(spec, schema, segmentsOf(read)))) {
        problems.push(`${where}: reads data.${read}, which the success response does not declare`);
      }
    }

    const marker = operation[AVAILABILITY_KEY] === UNAVAILABLE ? UNAVAILABLE : "available";
    if (marker !== entry.availability) {
      const message = `${where}: catalog availability is "${entry.availability}" but the document says "${marker}"`;
      if (options.availability === "exact" || marker === UNAVAILABLE) problems.push(message);
      else warnings.push(message);
    }
  }

  return { problems, warnings };
}
