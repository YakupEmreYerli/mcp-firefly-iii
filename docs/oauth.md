# Remote access with embedded OAuth

When `MCP_AUTH_PASSWORD` is set, this server also acts as an OAuth 2.1
authorization server, so no separate Keycloak or Authentik install is needed. It
provides dynamic client registration, PKCE S256, a login screen, a consent
screen, access tokens and rotating refresh tokens.

## Common setup

Set these in `.env`:

```dotenv
MCP_AUTH_PASSWORD=a-strong-password-of-at-least-12-characters
MCP_AUTH_STATE_DIR=/data/firefly-mcp-auth
MCP_RESOURCE_URL=https://mcp.example.com
```

The state directory must live on a persistent volume; if it is lost, every
client has to be authorized again. `MCP_RESOURCE_URL` must match the URL the
proxy publishes, character for character. Writing the internal Docker address
there fails the audience check, and the client only sees "invalid token".

## ChatGPT

1. Publish the server over HTTPS. For a home server, Cloudflare Tunnel is the
   recommended route.
2. In ChatGPT's plugin / custom connector screen, enter
   `https://mcp.example.com/mcp` as the MCP endpoint.
3. Choose OAuth as the authentication method.
4. On the Firefly screen that opens, enter the `MCP_AUTH_PASSWORD` password and
   approve the read, write or destructive scopes.

ChatGPT handles client registration, PKCE and the token exchange by itself.

## Claude web and Desktop

Add the same `/mcp` address as a custom connector and start the OAuth flow, then
complete the password and consent screens. Claude also registers as a public
client and uses PKCE; there is no static bearer token to enter.

## HTTPS options

### Cloudflare Tunnel — recommended

No port forwarding and no local certificate. Point a stable hostname at
Cloudflare in DNS and set the tunnel target to `http://firefly-mcp:3000`. Give
the `cloudflared` service in the compose example your `CLOUDFLARE_TUNNEL_TOKEN`.

### Caddy

On a VPS, point DNS at the server, run compose with the `caddy` profile and
change the hostname in `Caddyfile`. Caddy obtains the certificate on 80/443 and
proxies to `firefly-mcp:3000`:

```text
mcp.example.com {
    reverse_proxy firefly-mcp:3000
}
```

### Dokploy / Traefik

In Dokploy, create an HTTPS router bound to the domain and set the container
port to 3000. The equivalent labels are:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.firefly-mcp.rule=Host(`mcp.example.com`)
  - traefik.http.routers.firefly-mcp.entrypoints=websecure
  - traefik.http.routers.firefly-mcp.tls=true
  - traefik.http.services.firefly-mcp.loadbalancer.server.port=3000
```

In all three options `MCP_RESOURCE_URL` is the origin of the external hostname
and nothing else: `https://mcp.example.com`. The MCP connection URL may include
the `/mcp` alias. An internal host, a different port, or a path in the resource
value produces an audience mismatch.
