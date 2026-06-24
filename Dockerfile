# Stage 1: pinned mcp-auth-proxy Go binary (Renovate docker manager updates this tag)
FROM ghcr.io/sigbit/mcp-auth-proxy:2.10.2@sha256:f92e0ccd22b2a7585bccedc366a3c872bbfa3500c7fa5e7443b40962bf248e8d AS proxy

# Stage 2: shared Node base (Renovate docker manager updates this tag). node:26 satisfies all current MCPs.
FROM node:26.3.1-slim@sha256:f9b8bd6c62fcd007c08ce2bb2907485b624b968fd76094445822e0ec14002cf0
ARG MCP_DIR
ARG MCP_BIN

# node:*-slim omits the system CA bundle; the Go proxy uses the system trust store to verify the
# Authelia OIDC endpoint - without this it panics with x509: certificate signed by unknown authority.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=proxy /usr/local/bin/mcp-auth-proxy /usr/local/bin/mcp-auth-proxy

WORKDIR /app
COPY ${MCP_DIR}/package.json ${MCP_DIR}/package-lock.json ./
RUN npm ci --omit=dev

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENV MCP_BIN=$MCP_BIN
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
