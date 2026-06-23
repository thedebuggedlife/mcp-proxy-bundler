#!/usr/bin/env bash
set -euo pipefail

# Generates ephemeral CI secrets + renders the Authelia config/users files and a
# compose env file into the gitignored test/.secrets/ dir (D13: nothing secret
# committed). Idempotent: re-running regenerates everything from scratch.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTHELIA_TMPL_DIR="$REPO_ROOT/test/authelia"
SECRETS_DIR="$REPO_ROOT/test/.secrets"
AUTHELIA_OUT_DIR="$SECRETS_DIR/authelia"

AUTHELIA_IMAGE="${AUTHELIA_IMAGE:-ghcr.io/authelia/authelia:4.39.20}"

# Fixed, non-secret test parameters (consumed by the e2e test in Phase 9).
TEST_USER="${TEST_USER:-testuser}"
TEST_PASSWORD="${TEST_PASSWORD:-test-password-123}"
TEST_GROUP="${TEST_GROUP:-mcp-admins}"
TEST_EMAIL="${TEST_EMAIL:-testuser@example.com}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-mcp-proxy}"

rm -rf "$SECRETS_DIR"
mkdir -p "$AUTHELIA_OUT_DIR"
chmod 700 "$SECRETS_DIR"

# Random alphanumeric helper (length arg). Captures then slices with bash
# parameter expansion to avoid the `head`/`cut` SIGPIPE that trips pipefail.
rand_alnum() {
  local len="$1"
  local raw
  raw="$(openssl rand -hex "$len")"
  printf '%s' "${raw:0:$len}"
}

authelia_cli() {
  docker run --rm "$AUTHELIA_IMAGE" authelia "$@"
}

# Strip Authelia's "Digest: " prefix from a hash command's output.
strip_digest() {
  sed -n 's/^Digest: //p'
}

echo "Generating ephemeral test secrets into $SECRETS_DIR" >&2

# --- Random secrets ---------------------------------------------------------
SESSION_SECRET="$(rand_alnum 64)"
STORAGE_ENCRYPTION_KEY="$(rand_alnum 64)"
JWT_SECRET="$(rand_alnum 64)"
OIDC_HMAC_SECRET="$(rand_alnum 64)"
PROXY_AUTH_HMAC_SECRET="$(openssl rand -base64 32)"
MCP_API_KEY="dummy-api-key-$(rand_alnum 12)"
OIDC_CLIENT_SECRET="$(rand_alnum 48)"

# --- Argon2 password hash for the test user ---------------------------------
USER_PASSWORD_HASH="$(authelia_cli crypto hash generate argon2 \
  --password "$TEST_PASSWORD" --no-confirm | strip_digest)"
[ -n "$USER_PASSWORD_HASH" ] || { echo "error: empty argon2 hash" >&2; exit 1; }

# --- PBKDF2 hash of the OIDC client secret (Authelia stores the hash; the
#     proxy gets the plaintext) -------------------------------------------------
OIDC_CLIENT_SECRET_HASH="$(authelia_cli crypto hash generate pbkdf2 \
  --variant sha512 --iterations 310000 \
  --password "$OIDC_CLIENT_SECRET" --no-confirm | strip_digest)"
[ -n "$OIDC_CLIENT_SECRET_HASH" ] || { echo "error: empty pbkdf2 hash" >&2; exit 1; }

# --- RSA signing key for the OIDC provider JWKS -----------------------------
OIDC_JWKS_KEY="$(openssl genrsa 2>/dev/null | openssl pkcs8 -topk8 -nocrypt 2>/dev/null)"
[ -n "$OIDC_JWKS_KEY" ] || { echo "error: empty RSA key" >&2; exit 1; }
# Indent the PEM by ten spaces for the YAML block scalar under `key: |` (which
# sits at eight-space indentation, so its content must be indented further).
OIDC_JWKS_KEY_INDENTED="$(printf '%s\n' "$OIDC_JWKS_KEY" | sed 's/^/          /')"

# --- TLS cert for Authelia's listener ---------------------------------------
# Authelia refuses to advertise an http OIDC issuer (it rejects an effective
# proto of 'http'), so the listener must be genuine TLS. The proxy reaches it at
# https://authelia:9091 and trusts this self-signed cert via SSL_CERT_FILE
# (mounted at runtime; the image is NOT modified). SANs cover the in-network
# service name and localhost for host-side probes.
TLS_DIR="$AUTHELIA_OUT_DIR/tls"
mkdir -p "$TLS_DIR"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TLS_DIR/authelia.key" \
  -out "$TLS_DIR/authelia.crt" \
  -days 7 -subj '/CN=authelia.test' \
  -addext 'subjectAltName=DNS:authelia.test,DNS:authelia,DNS:localhost,IP:127.0.0.1' \
  >/dev/null 2>&1
[ -s "$TLS_DIR/authelia.crt" ] || { echo "error: failed to generate Authelia TLS cert" >&2; exit 1; }

# CA bundle the proxy trusts = the system bundle is not needed for Authelia;
# the proxy only talks TLS to Authelia, so the cert alone suffices as the trust
# root for SSL_CERT_FILE.
cp "$TLS_DIR/authelia.crt" "$AUTHELIA_OUT_DIR/proxy-ca.crt"

# --- Render users.yml -------------------------------------------------------
sed \
  -e "s|@@TEST_USER@@|$TEST_USER|g" \
  -e "s|@@TEST_DISPLAYNAME@@|Test User|g" \
  -e "s|@@TEST_EMAIL@@|$TEST_EMAIL|g" \
  -e "s|@@TEST_GROUP@@|$TEST_GROUP|g" \
  -e "s|@@USER_PASSWORD_HASH@@|$USER_PASSWORD_HASH|g" \
  "$AUTHELIA_TMPL_DIR/users.yml.tmpl" >"$AUTHELIA_OUT_DIR/users.yml"

# --- Render configuration.yml ----------------------------------------------
# Use a python/awk-free approach: write the multi-line JWKS key via an
# intermediate file substitution (sed can't easily inject multi-line content).
RENDERED_CONFIG="$AUTHELIA_OUT_DIR/configuration.yml"
sed \
  -e "s|@@SESSION_SECRET@@|$SESSION_SECRET|g" \
  -e "s|@@STORAGE_ENCRYPTION_KEY@@|$STORAGE_ENCRYPTION_KEY|g" \
  -e "s|@@JWT_SECRET@@|$JWT_SECRET|g" \
  -e "s|@@OIDC_HMAC_SECRET@@|$OIDC_HMAC_SECRET|g" \
  -e "s|@@OIDC_CLIENT_ID@@|$OIDC_CLIENT_ID|g" \
  -e "s|@@OIDC_CLIENT_SECRET_HASH@@|$OIDC_CLIENT_SECRET_HASH|g" \
  -e "s|@@TEST_GROUP@@|$TEST_GROUP|g" \
  "$AUTHELIA_TMPL_DIR/configuration.yml.tmpl" >"$RENDERED_CONFIG.partial"

# Inject the multi-line JWKS key at the @@OIDC_JWKS_KEY@@ marker line.
{
  while IFS= read -r line; do
    if [ "$line" = "@@OIDC_JWKS_KEY@@" ]; then
      printf '%s\n' "$OIDC_JWKS_KEY_INDENTED"
    else
      printf '%s\n' "$line"
    fi
  done <"$RENDERED_CONFIG.partial"
} >"$RENDERED_CONFIG"
rm -f "$RENDERED_CONFIG.partial"

# --- Compose env file -------------------------------------------------------
cat >"$SECRETS_DIR/test.env" <<EOF
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET
PROXY_AUTH_HMAC_SECRET=$PROXY_AUTH_HMAC_SECRET
MCP_API_KEY=$MCP_API_KEY
TEST_USER=$TEST_USER
TEST_PASSWORD=$TEST_PASSWORD
TEST_GROUP=$TEST_GROUP
TEST_EMAIL=$TEST_EMAIL
EOF

# The Authelia config dir must be readable, and the rendered files must be
# world-readable for the container (Authelia runs as a non-root user inside).
chmod -R a+rX "$AUTHELIA_OUT_DIR"

echo "Wrote: $AUTHELIA_OUT_DIR/{configuration.yml,users.yml}, $SECRETS_DIR/test.env" >&2
