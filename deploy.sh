#!/bin/bash

# MCP Server - Google Cloud Deployment Script
# TypeScript with Node.js - MCP 2025-11-25 specification

set -e

# =============================================================================
# Configuration - Customize these for your deployment
# =============================================================================

PROJECT_ID=${PROJECT_ID:-"your-gcp-project-id"}
REGION=${REGION:-"us-west2"}
REPO_NAME=${REPO_NAME:-"mcp-servers"}
SERVICE_NAME=${SERVICE_NAME:-"template-mcp-server"}
MCP_SERVER_NAME=${MCP_SERVER_NAME:-"template_mcp"}
SERVICE_ACCOUNT_NAME=${SERVICE_ACCOUNT_NAME:-"mcp-server-sa"}

# OAuth Configuration (SaaS Provider OAuth - NOT Agentman)
# These point to YOUR SaaS provider's OAuth endpoints
OAUTH_ISSUER=${OAUTH_ISSUER:-""}
OAUTH_AUTHORIZATION_ENDPOINT=${OAUTH_AUTHORIZATION_ENDPOINT:-""}
OAUTH_TOKEN_ENDPOINT=${OAUTH_TOKEN_ENDPOINT:-""}
OAUTH_SCOPES=${OAUTH_SCOPES:-""}

# SaaS API Configuration
SAAS_API_BASE_URL=${SAAS_API_BASE_URL:-""}

# =============================================================================
# Script Start
# =============================================================================

echo "============================================================"
echo "MCP Server Deployment"
echo "============================================================"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Service: $SERVICE_NAME"
echo "MCP Server Name: $MCP_SERVER_NAME"
echo "Transport: Stateless HTTP (MCP 2025-11-25)"
echo "OAuth Issuer: ${OAUTH_ISSUER:-"(not configured)"}"
echo "============================================================"
echo ""

# Check if gcloud is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "Error: Please authenticate with gcloud first:"
    echo "   gcloud auth login"
    exit 1
fi

# Set the project
echo "Setting GCP project..."
gcloud config set project $PROJECT_ID

# Create Artifact Registry repository (if not exists)
echo "Ensuring Artifact Registry repository exists..."
gcloud artifacts repositories create $REPO_NAME \
    --repository-format=docker \
    --location=$REGION \
    --quiet 2>/dev/null || echo "Repository already exists"

# Create service account (if not exists)
echo "Creating service account..."
gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME \
    --display-name="MCP Server Service Account" \
    --quiet 2>/dev/null || echo "Service account already exists"

# Grant necessary permissions
echo "Granting permissions to service account..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/run.invoker" \
    --quiet 2>/dev/null || echo "Permission already granted"

# Generate a tag from git SHA or timestamp
if git rev-parse --short HEAD &>/dev/null; then
    TAG=$(git rev-parse --short HEAD)
else
    TAG=$(date +%Y%m%d-%H%M%S)
fi

echo "Using tag: $TAG"

# Compute MCP_SERVER_URL from service URL (will be set after first deployment)
MCP_SERVER_URL=${MCP_SERVER_URL:-""}

# Build and deploy using Cloud Build
echo ""
echo "Building and deploying with Cloud Build..."
gcloud builds submit \
    --config=cloudbuild.yaml \
    --substitutions=_REGION=$REGION,_REPO=$REPO_NAME,_SERVICE_NAME=$SERVICE_NAME,_SERVICE_ACCOUNT=$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com,_MCP_SERVER_NAME=$MCP_SERVER_NAME,_MCP_SERVER_URL=$MCP_SERVER_URL,_OAUTH_ISSUER=$OAUTH_ISSUER,_OAUTH_AUTHORIZATION_ENDPOINT=$OAUTH_AUTHORIZATION_ENDPOINT,_OAUTH_TOKEN_ENDPOINT=$OAUTH_TOKEN_ENDPOINT,_OAUTH_SCOPES=$OAUTH_SCOPES,_SAAS_API_BASE_URL=$SAAS_API_BASE_URL,SHORT_SHA=$TAG \
    .

# Get service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
    --region=$REGION \
    --format='value(status.url)' 2>/dev/null || echo "Service not yet deployed")

echo ""
echo "============================================================"
echo "Deployment Complete!"
echo "============================================================"
echo ""
echo "Service URL: $SERVICE_URL"
echo "MCP Endpoint: $SERVICE_URL/mcp"
echo ""
echo "OAuth Well-Known Endpoints:"
echo "  $SERVICE_URL/.well-known/oauth-authorization-server"
echo "  $SERVICE_URL/.well-known/oauth-protected-resource"
echo ""
echo "Test Commands:"
echo "============================================================"
echo ""
echo "# Health check"
echo "curl $SERVICE_URL/health"
echo ""
echo "# OAuth metadata"
echo "curl $SERVICE_URL/.well-known/oauth-authorization-server"
echo ""
echo "# Initialize (will return 401 without token - triggers OAuth)"
echo "curl -X POST $SERVICE_URL/mcp \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Accept: application/json' \\"
echo "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0.0\"}}}'"
echo ""
echo "# Initialize with token"
echo "curl -X POST $SERVICE_URL/mcp \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Accept: application/json' \\"
echo "  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \\"
echo "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0.0\"}}}'"
echo ""
echo "# List tools"
echo "curl -X POST $SERVICE_URL/mcp \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Accept: application/json' \\"
echo "  -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}'"
echo ""
echo "============================================================"
echo ""
echo "NOTE: If this is the first deployment, update MCP_SERVER_URL"
echo "and redeploy to set the correct resource URL in OAuth metadata."
echo "============================================================"
