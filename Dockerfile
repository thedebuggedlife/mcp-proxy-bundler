ARG MCP_IMAGE=scratch

# Literal, digest-pinned upstreams: single-sourced for Renovate and the build scripts' version parse.
FROM ghcr.io/sigbit/mcp-auth-proxy:2.10.2@sha256:f92e0ccd22b2a7585bccedc366a3c872bbfa3500c7fa5e7443b40962bf248e8d AS proxy
FROM node:26.9.0-slim@sha256:3a771f83944bb763050c23c0225c260638c4b7899e7a72485ef75e5e570499e5 AS node-upstream
FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:6a94333d37514e385650a3c81a55e5350b67253dbe136e9cf17e499c35606a8c AS dotnet-upstream
# Artifact carrier for image-distributed MCPs; the real pin lives in mcps/<name>/upstream.Dockerfile.
FROM ${MCP_IMAGE} AS mcp-image

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

FROM dotnet-upstream AS dotnet
ARG MCP_LAUNCH

# The schema shim runs on Node, whose binary needs libatomic; the ASP.NET image does not ship it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libatomic1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node-upstream /usr/local/bin/node /usr/local/bin/node
COPY --from=mcp-image /app /app/mcp
# The .NET host resolves appsettings.json from the working directory.
WORKDIR /app/mcp
ENV DOTNET_EnableDiagnostics=0

COPY --from=common / /
RUN test -n "$MCP_LAUNCH" \
 && printf '#!/bin/sh\nexec %s "$@"\n' "$MCP_LAUNCH" > /app/mcp-launch \
 && chmod +x /app/mcp-launch
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
