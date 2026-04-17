#!/bin/bash

# MCP Server - Production Environment Deployment Script
# Deploys to the dedicated MCP servers project (agentman-public-mcp-servers)
# Following the Agentman MCP deployment pattern
#
# Usage:
#   ./deploy-prod.sh
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Edit the configuration below for your SaaS integration
#   - Test deployment should be verified before running this

set -e

# Cleanup temp files on exit (including Ctrl+C)
trap 'rm -f current-url-map.yaml updated-url-map.yaml' EXIT

# =============================================================================
# CONFIGURATION - Edit these for your SaaS integration
# =============================================================================

# Service naming
SERVICE_NAME="claudeagents-server"
MCP_SERVER_NAME="claudeagents_mcp"
PATH_PREFIX="claudeagents"               # URL: mcp.agentman.ai/claudeagents/mcp

# OAuth configuration — uses the template's OAuth broker mode.
# Claude.ai requires OAuth discovery to work. Our "OAuth flow" is a simple
# page that asks the user to paste their Anthropic API key, then issues
# an opaque token wrapping that key.
OAUTH_ISSUER="https://mcp.agentman.ai/claudeagents"
OAUTH_AUTHORIZATION_URL="https://mcp.agentman.ai/claudeagents/oauth/authorize"
OAUTH_TOKEN_URL="https://mcp.agentman.ai/claudeagents/oauth/token"
OAUTH_SCOPES=""

# Anthropic API base URL
SAAS_API_BASE_URL="https://api.anthropic.com"

# =============================================================================
# Infrastructure Configuration (usually don't need to change)
# =============================================================================

PROJECT_ID=${PROJECT_ID:-"agentman-public-mcp-servers"}
REGION=${REGION:-"us-west2"}
DOMAIN=${DOMAIN:-"mcp.agentman.ai"}
REPO_NAME="mcp-servers"
NODE_ENV="production"
LOG_LEVEL="info"

echo "🚀 Deploying PRODUCTION ${MCP_SERVER_NAME} MCP Server to Google Cloud"
echo "======================================================================"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Domain: $DOMAIN"
echo "Service: $SERVICE_NAME"
echo "Path: /$PATH_PREFIX"
echo ""

# Confirmation prompt for production
read -p "⚠️  Are you sure you want to deploy to PRODUCTION? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "❌ Deployment cancelled."
    exit 1
fi

# Check if gcloud is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "❌ Please authenticate with gcloud first:"
    echo "   gcloud auth login"
    exit 1
fi

# Set the project
gcloud config set project $PROJECT_ID

# Generate a tag (use git SHA or timestamp)
if [ -z "$SHORT_SHA" ]; then
    if git rev-parse --short HEAD &>/dev/null; then
        TAG=$(git rev-parse --short HEAD)
    else
        TAG=$(date +%Y%m%d-%H%M%S)
    fi
else
    TAG=$SHORT_SHA
fi

echo "📦 Using tag: $TAG"

# Anthropic-specific env vars
ANTHROPIC_VERSION="2023-06-01"
ANTHROPIC_BETA="managed-agents-2026-04-01"

# Dummy upstream OAuth credentials — the template requires these when
# OAUTH_SERVER_ENABLED=true, but our custom API-key-paste flow never uses them.
export UPSTREAM_CLIENT_ID="not-used-apikey-flow"
export UPSTREAM_CLIENT_SECRET="not-used-apikey-flow"
export UPSTREAM_AUTH_URL="https://not-used.example.com/auth"
export UPSTREAM_TOKEN_URL="https://not-used.example.com/token"

# Build and deploy using Cloud Build
echo "🔨 Building and deploying with Cloud Build..."
echo "   API URL: $SAAS_API_BASE_URL"
echo "   Anthropic Version: $ANTHROPIC_VERSION"
echo "   Anthropic Beta: $ANTHROPIC_BETA"
gcloud builds submit \
    --config=cloudbuild.yaml \
    --substitutions=_REGION=$REGION,_REPO=$REPO_NAME,_SERVICE_NAME=$SERVICE_NAME,_MCP_SERVER_NAME=$MCP_SERVER_NAME,SHORT_SHA=$TAG,_NODE_ENV=$NODE_ENV,_LOG_LEVEL=$LOG_LEVEL,_OAUTH_ISSUER=$OAUTH_ISSUER,_OAUTH_AUTHORIZATION_URL=$OAUTH_AUTHORIZATION_URL,_OAUTH_TOKEN_URL=$OAUTH_TOKEN_URL,_OAUTH_SCOPES=$OAUTH_SCOPES,_SAAS_API_BASE_URL=$SAAS_API_BASE_URL,_ANTHROPIC_VERSION=$ANTHROPIC_VERSION,_ANTHROPIC_BETA=$ANTHROPIC_BETA,_MCP_SERVER_URL=https://$DOMAIN/$PATH_PREFIX \
    .

# Create or update serverless NEG
echo "📡 Creating serverless NEG..."
gcloud compute network-endpoint-groups create ${SERVICE_NAME}-neg \
    --region=$REGION \
    --network-endpoint-type=serverless \
    --cloud-run-service=$SERVICE_NAME \
    --quiet 2>/dev/null || echo "NEG already exists"

# Create backend service
echo "🔙 Creating backend service..."
gcloud compute backend-services create ${SERVICE_NAME}-bs \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --protocol=HTTP \
    --global \
    --quiet 2>/dev/null || echo "Backend service already exists"

# Add NEG to backend service
echo "🔗 Adding NEG to backend service..."
gcloud compute backend-services add-backend ${SERVICE_NAME}-bs \
    --global \
    --network-endpoint-group=${SERVICE_NAME}-neg \
    --network-endpoint-group-region=$REGION \
    --quiet 2>/dev/null || echo "Backend already added"

# Update URL map
echo "🗺️  Updating URL map..."

# Export existing URL map
gcloud compute url-maps export mcp-url-map \
    --global \
    --destination=current-url-map.yaml \
    --quiet 2>/dev/null || {
    echo "⚠️  URL map doesn't exist. Creating new one..."
    cat > current-url-map.yaml <<EOF
defaultService: projects/$PROJECT_ID/global/backendServices/${SERVICE_NAME}-bs
name: mcp-url-map
pathMatchers:
- name: mcp-path-matcher
  defaultService: projects/$PROJECT_ID/global/backendServices/${SERVICE_NAME}-bs
  pathRules: []
hostRules:
- hosts:
  - "$DOMAIN"
  pathMatcher: mcp-path-matcher
EOF
}

# Add per-endpoint path rules with urlRewrite (strips path prefix for Cloud Run)
python3 - <<EOF
import yaml
import sys
import os

PROJECT_ID = os.environ.get('PROJECT_ID', 'agentman-public-mcp-servers')
SERVICE_NAME = "${SERVICE_NAME}"
PATH_PREFIX = "${PATH_PREFIX}"
BACKEND = f"projects/{PROJECT_ID}/global/backendServices/{SERVICE_NAME}-bs"

# Endpoints to expose with urlRewrite (LB path -> Cloud Run path)
# Cloud Run receives the rewritten path, so /your-saas/mcp -> /mcp
ENDPOINTS = [
    ("/{prefix}/health",                                  "/health"),
    ("/{prefix}/mcp",                                     "/mcp"),
    # OAuth discovery - both RFC 8414 path styles:
    # Style 1: /{prefix}/.well-known/... (non-standard but common)
    ("/{prefix}/.well-known/oauth-authorization-server",  "/.well-known/oauth-authorization-server"),
    ("/{prefix}/.well-known/oauth-protected-resource",    "/.well-known/oauth-protected-resource"),
    # Style 2: /.well-known/.../prefix (RFC 8414 Section 3 with path suffix)
    ("/.well-known/oauth-authorization-server/{prefix}",  "/.well-known/oauth-authorization-server"),
    ("/.well-known/oauth-protected-resource/{prefix}",    "/.well-known/oauth-protected-resource"),
    # OAuth flow endpoints
    ("/{prefix}/oauth/authorize",                         "/oauth/authorize"),
    ("/{prefix}/oauth/token",                             "/oauth/token"),
    ("/{prefix}/oauth/register",                          "/oauth/register"),
    ("/{prefix}/oauth/callback",                          "/oauth/callback"),
    ("/{prefix}/oauth/callback-apikey",                   "/oauth/callback-apikey"),
    ("/{prefix}/oauth/revoke",                            "/oauth/revoke"),
    ("/{prefix}",                                         "/"),
]

# Read the current URL map
with open('current-url-map.yaml', 'r') as f:
    url_map = yaml.safe_load(f)

# Find the path matcher
path_matcher = None
for pm in url_map.get('pathMatchers', []):
    if pm['name'] == 'mcp-path-matcher':
        path_matcher = pm
        break

if not path_matcher:
    path_matcher = {
        'name': 'mcp-path-matcher',
        'defaultService': BACKEND,
        'pathRules': []
    }
    url_map['pathMatchers'] = [path_matcher]

if 'pathRules' not in path_matcher:
    path_matcher['pathRules'] = []

# Remove any existing rules for this prefix
path_matcher['pathRules'] = [
    rule for rule in path_matcher['pathRules']
    if not any(p.startswith(f'/{PATH_PREFIX}') for p in rule.get('paths', []))
]

# Add per-endpoint rules with urlRewrite
for lb_path_tpl, rewrite_path in ENDPOINTS:
    lb_path = lb_path_tpl.format(prefix=PATH_PREFIX)
    path_matcher['pathRules'].append({
        'paths': [lb_path],
        'routeAction': {'urlRewrite': {'pathPrefixRewrite': rewrite_path}},
        'service': BACKEND,
    })

# Write the updated URL map
with open('updated-url-map.yaml', 'w') as f:
    yaml.dump(url_map, f, default_flow_style=False)

print("✅ URL map updated with per-endpoint urlRewrite rules")
EOF

# Import the updated URL map
gcloud compute url-maps import mcp-url-map \
    --global \
    --source=updated-url-map.yaml \
    --quiet

# Get service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
    --region=$REGION \
    --format='value(status.url)' 2>/dev/null || echo "Service not yet deployed")

# Get static IP
STATIC_IP=$(gcloud compute addresses describe mcp-ip --global --format="value(address)" 2>/dev/null || echo "Not configured")

echo ""
echo "🎉 PRODUCTION Deployment Complete!"
echo "==================================="
echo "✅ Service: $SERVICE_NAME"
echo "✅ Cloud Run URL: $SERVICE_URL"
echo "✅ Load Balancer Path: https://$DOMAIN/$PATH_PREFIX"
echo "✅ MCP Endpoint: https://$DOMAIN/$PATH_PREFIX/mcp"
echo "✅ Static IP: $STATIC_IP"
echo ""
echo "📋 Claude Desktop Configuration:"
echo "================================="
echo "Add to claude_desktop_config.json:"
echo ""
echo "{"
echo "  \"mcpServers\": {"
echo "    \"${MCP_SERVER_NAME}\": {"
echo "      \"url\": \"https://$DOMAIN/$PATH_PREFIX/mcp\","
echo "      \"transport\": \"http\""
echo "    }"
echo "  }"
echo "}"
echo ""
echo "🧪 Test Commands:"
echo "================"
echo "# Test health endpoint"
echo "curl https://$DOMAIN/$PATH_PREFIX/health"
echo ""
echo "# Test MCP endpoint"
echo "curl -X POST https://$DOMAIN/$PATH_PREFIX/mcp \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'"
echo ""

# Cleanup handled by EXIT trap

echo "🚀 PRODUCTION ${MCP_SERVER_NAME} MCP Server is now live at https://$DOMAIN/$PATH_PREFIX/mcp"
