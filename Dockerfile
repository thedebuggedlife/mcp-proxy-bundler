# Literal, digest-pinned upstreams: single-sourced for Renovate and the build scripts' version parse.
FROM ghcr.io/sigbit/mcp-auth-proxy:2.10.2@sha256:f92e0ccd22b2a7585bccedc366a3c872bbfa3500c7fa5e7443b40962bf248e8d AS proxy
FROM node:26.10.0-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS node-upstream

# Runtime-neutral payload, defined once for every runtime target.
FROM scratch AS common
COPY --from=proxy /usr/local/bin/mcp-auth-proxy /usr/local/bin/mcp-auth-proxy
# WORKAROUND(mcp-auth-proxy#178): stdio schema-normalizer shim. Remove with the
# shim (see mcp-schema-shim.cjs header + entrypoint.sh) once #178 is fixed upstream.
COPY mcp-schema-shim.cjs /app/mcp-schema-shim.cjs
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

FROM node-upstream AS node
ARG MCP_DIR
ARG MCP_LAUNCH

# node:*-slim omits the system CA bundle; the Go proxy uses the system trust store to verify the
# Authelia OIDC endpoint - without this it panics with x509: certificate signed by unknown authority.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY ${MCP_DIR}/package.json ${MCP_DIR}/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=common / /
RUN test -n "$MCP_LAUNCH" \
 && printf '#!/bin/sh\nexec %s "$@"\n' "$MCP_LAUNCH" > /app/mcp-launch \
 && chmod +x /app/mcp-launch
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
