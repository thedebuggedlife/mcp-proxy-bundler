ARG MCP_IMAGE=scratch

# Literal, digest-pinned upstreams: single-sourced for Renovate and the build scripts' version parse.
FROM ghcr.io/sigbit/mcp-auth-proxy:2.10.2@sha256:f92e0ccd22b2a7585bccedc366a3c872bbfa3500c7fa5e7443b40962bf248e8d AS proxy
FROM node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS node-upstream
FROM mcr.microsoft.com/dotnet/aspnet:10.0.13-noble@sha256:8af87eba5e7cdafb1514d7388be287365da97c132509e84dfe252ffd552398ca AS dotnet-upstream
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
