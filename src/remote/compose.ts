import { parse } from "yaml";

/** What the remote setup needs to know about the compose file Firefly III
 * already runs from: which service is Firefly, and which networks exist. */
export type ComposeInfo = {
  fireflyServices: Array<{ name: string; networks: string[] }>;
  networks: Array<{ key: string; name: string; external: boolean }>;
};

export const COMPOSE_FILE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

const FIREFLY_IMAGE = /^(docker\.io\/)?fireflyiii\/core(:|@|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Network names a service joins: a list, a map, or none (Compose's default). */
function serviceNetworks(service: Record<string, unknown>): string[] {
  const { networks } = service;
  if (Array.isArray(networks)) return networks.filter((n): n is string => typeof n === "string");
  if (isRecord(networks)) return Object.keys(networks);
  return ["default"];
}

export function readCompose(text: string): ComposeInfo {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new Error(`Could not read the compose file: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (!isRecord(doc)) throw new Error("Could not read the compose file: it is not a YAML mapping.");

  const services = isRecord(doc.services) ? doc.services : {};
  const fireflyServices = Object.entries(services)
    .filter(([, service]) => isRecord(service) && typeof service.image === "string" && FIREFLY_IMAGE.test(service.image))
    .map(([name, service]) => ({ name, networks: serviceNetworks(service as Record<string, unknown>) }));

  const declared = isRecord(doc.networks) ? doc.networks : {};
  const networks = Object.entries(declared).map(([key, value]) => {
    const spec = isRecord(value) ? value : {};
    return { key, name: typeof spec.name === "string" ? spec.name : key, external: spec.external === true };
  });

  return { fireflyServices, networks };
}
