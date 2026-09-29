import { fileURLToPath } from "node:url";

export const PUBLISHED_OPENAPI_URL = process.env.BACKWORK_OPENAPI_URL || "https://backworkhealth.com/openapi.json";
export const VENDORED_OPENAPI_PATH = fileURLToPath(new URL("../openapi/backwork-openapi.json", import.meta.url));
