import { describe, expect, it } from "vitest";
import { readCompose } from "../../src/remote/compose.js";

// The shape of Firefly III's own docker-compose.yml.
const official = `
services:
  app:
    image: fireflyiii/core:latest
    hostname: app
    container_name: firefly_iii_core
    networks:
      - firefly_iii
    restart: always
    volumes:
      - firefly_iii_upload:/var/www/html/storage/upload
    env_file: .env
    ports:
      - '80:8080'
  db:
    image: mariadb:lts
    networks:
      - firefly_iii
networks:
  firefly_iii:
    driver: bridge
volumes:
  firefly_iii_upload:
`;

describe("readCompose", () => {
  it("finds the Firefly III service and its networks", () => {
    const info = readCompose(official);
    expect(info.fireflyServices).toEqual([{ name: "app", networks: ["firefly_iii"] }]);
    expect(info.networks).toEqual([{ key: "firefly_iii", name: "firefly_iii", external: false }]);
  });

  it("puts a service without networks on the default network", () => {
    const info = readCompose("services:\n  firefly:\n    image: fireflyiii/core:version-6.7.9\n");
    expect(info.fireflyServices).toEqual([{ name: "firefly", networks: ["default"] }]);
  });

  it("reads networks given as a map, and external networks with their real name", () => {
    const info = readCompose(`
services:
  app:
    image: fireflyiii/core
    networks:
      internal: {}
      proxy:
        aliases: [firefly]
networks:
  internal: {}
  proxy:
    external: true
    name: traefik_proxy
`);
    expect(info.fireflyServices[0]!.networks).toEqual(["internal", "proxy"]);
    expect(info.networks).toContainEqual({ key: "proxy", name: "traefik_proxy", external: true });
  });

  it("returns no Firefly service when none uses the Firefly III image", () => {
    expect(readCompose("services:\n  web:\n    image: nginx\n").fireflyServices).toEqual([]);
  });

  it("returns every Firefly service when there are several, without picking one", () => {
    const info = readCompose("services:\n  a:\n    image: fireflyiii/core\n  b:\n    image: fireflyiii/core:latest\n");
    expect(info.fireflyServices.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("explains a file it cannot parse", () => {
    expect(() => readCompose("services: [unclosed")).toThrow(/could not read/i);
  });
});
