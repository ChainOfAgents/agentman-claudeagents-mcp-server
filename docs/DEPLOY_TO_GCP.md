# Deploying MCP Server to Google Cloud

This guide explains how to deploy your MCP server to Google Cloud Run and configure it behind the shared load balancer at `mcp.agentman.ai`.

## Architecture Overview

```
https://mcp.agentman.ai/<your-path>/mcp
  ↓
Static IP (mcp-ip)
  ↓
Global Load Balancer (HTTPS)
  ↓
URL Map (mcp-url-map) → Routes based on path
  ↓
Backend Service (<your-service>-bs)
  ↓
Network Endpoint Group (<your-service>-neg)
  ↓
Cloud Run Service (<your-service>)
```

## Prerequisites

1. **Google Cloud CLI** installed and authenticated:
   ```bash
   gcloud auth login
   gcloud config set project agentman-public-mcp-servers
   ```

2. **Python 3** with PyYAML (for URL map updates):
   ```bash
   pip install pyyaml
   ```

3. **Your MCP server code** customized from this template

## Quick Start

### 1. Configure Your Service

Edit the configuration section in the deploy scripts:

**deploy-test.sh** (test environment):
```bash
SERVICE_NAME="test-gmail-server"     # Cloud Run service name
MCP_SERVER_NAME="gmail_mcp"          # MCP server identifier
PATH_PREFIX="gmail"                   # URL path: mcp.agentman.ai/gmail

# OAuth (test/staging)
OAUTH_ISSUER="https://studio.chainoftasks.ai"
OAUTH_AUTHORIZATION_URL="https://studio.chainoftasks.ai/oauth/authorize"
OAUTH_TOKEN_URL="https://studio.chainoftasks.ai/oauth/token"
OAUTH_SCOPES="gmail.read,gmail.send"

# SaaS API
SAAS_API_BASE_URL="https://gmail.googleapis.com"
```

**deploy-prod.sh** (production environment):
```bash
SERVICE_NAME="gmail-server"          # Cloud Run service name (no test- prefix)
MCP_SERVER_NAME="gmail_mcp"
PATH_PREFIX="gmail"

# OAuth (production)
OAUTH_ISSUER="https://studio.agentman.ai"
OAUTH_AUTHORIZATION_URL="https://studio.agentman.ai/oauth/authorize"
OAUTH_TOKEN_URL="https://studio.agentman.ai/oauth/token"
OAUTH_SCOPES="gmail.read,gmail.send"

SAAS_API_BASE_URL="https://gmail.googleapis.com"
```

### 2. Deploy to Test Environment

```bash
./deploy-test.sh
```

This will:
- Build your Docker image
- Push to Artifact Registry
- Deploy to Cloud Run
- Configure load balancer routing
- Output the test URL

### 3. Test Your Deployment

```bash
# Health check
curl https://mcp.agentman.ai/gmail/health

# List tools
curl -X POST https://mcp.agentman.ai/gmail/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 4. Deploy to Production

After testing is complete:

```bash
./deploy-prod.sh
```

## URL Structure

All MCP servers are accessible at:

```
https://mcp.agentman.ai/<path-prefix>/mcp
```

Examples:
| Service | Path | MCP Endpoint |
|---------|------|--------------|
| Gmail | `/gmail` | `https://mcp.agentman.ai/gmail/mcp` |
| Shopify | `/shopify` | `https://mcp.agentman.ai/shopify/mcp` |
| QuickBooks | `/quickbooks` | `https://mcp.agentman.ai/quickbooks/mcp` |
| HubSpot | `/hubspot` | `https://mcp.agentman.ai/hubspot/mcp` |

## Path Naming Conventions

Choose your path prefix carefully:

- Use **lowercase**
- Use **hyphens** (not underscores) for multi-word names
- Keep it **short and descriptive**
- Match the **SaaS service name**

Examples:
- `gmail` (not `google-mail`)
- `google-calendar` (not `gcal`)
- `hubspot-employee` (for HubSpot employee portal)

## Adding a New MCP Server

### Step 1: Clone This Template

```bash
git clone https://github.com/ChainOfAgents/agentman-mcp-server-template your-saas-mcp-server
cd your-saas-mcp-server
```

### Step 2: Customize for Your SaaS

1. Edit `src/tools/index.ts` - Define your tools
2. Edit `src/config.ts` - Update server name
3. Edit `deploy-test.sh` and `deploy-prod.sh` - Configure paths and OAuth

### Step 3: Deploy

```bash
# Test first
./deploy-test.sh

# Then production
./deploy-prod.sh
```

## Manual Deployment Steps

If you need more control, here are the individual steps:

### 1. Deploy Cloud Run Service

```bash
SERVICE_NAME="your-service"
REGION="us-west2"

gcloud builds submit \
    --config=cloudbuild.yaml \
    --substitutions=_SERVICE_NAME=$SERVICE_NAME,SHORT_SHA=$(git rev-parse --short HEAD)
```

### 2. Create Network Endpoint Group (NEG)

```bash
gcloud compute network-endpoint-groups create ${SERVICE_NAME}-neg \
    --region=$REGION \
    --network-endpoint-type=serverless \
    --cloud-run-service=$SERVICE_NAME
```

### 3. Create Backend Service

```bash
gcloud compute backend-services create ${SERVICE_NAME}-bs \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --protocol=HTTPS \
    --global
```

### 4. Add NEG to Backend Service

```bash
gcloud compute backend-services add-backend ${SERVICE_NAME}-bs \
    --global \
    --network-endpoint-group=${SERVICE_NAME}-neg \
    --network-endpoint-group-region=$REGION
```

### 5. Update URL Map

```bash
# Export current URL map
gcloud compute url-maps export mcp-url-map \
    --global \
    --destination=url-map.yaml

# Edit url-map.yaml to add your path rule
# Then import
gcloud compute url-maps import mcp-url-map \
    --global \
    --source=url-map.yaml
```

## Viewing Current URL Map

To see all configured paths:

```bash
gcloud compute url-maps describe mcp-url-map \
    --global \
    --format="yaml(pathMatchers.pathRules)"
```

## Removing a Service

To remove a service from the load balancer:

```bash
SERVICE_NAME="your-service"
PATH_PREFIX="your-path"
REGION="us-west2"

# 1. Update URL map (remove path rule)
gcloud compute url-maps export mcp-url-map --global --destination=url-map.yaml
# Edit url-map.yaml to remove your path rule
gcloud compute url-maps import mcp-url-map --global --source=url-map.yaml

# 2. Remove backend
gcloud compute backend-services remove-backend ${SERVICE_NAME}-bs \
    --global \
    --network-endpoint-group=${SERVICE_NAME}-neg \
    --network-endpoint-group-region=$REGION

# 3. Delete backend service
gcloud compute backend-services delete ${SERVICE_NAME}-bs --global --quiet

# 4. Delete NEG
gcloud compute network-endpoint-groups delete ${SERVICE_NAME}-neg \
    --region=$REGION --quiet

# 5. Optionally delete Cloud Run service
gcloud run services delete $SERVICE_NAME --region=$REGION --quiet
```

## Troubleshooting

### 404 Not Found

**Cause:** Path rule not configured or load balancer not updated

**Solution:**
```bash
# Verify URL map has your path
gcloud compute url-maps describe mcp-url-map --global

# Wait 30-60 seconds for load balancer to update
```

### 502 Bad Gateway

**Cause:** Backend service can't reach Cloud Run

**Solution:**
```bash
# Check NEG status
gcloud compute network-endpoint-groups describe ${SERVICE_NAME}-neg --region=us-west2

# Check Cloud Run service is running
gcloud run services describe $SERVICE_NAME --region=us-west2
```

### 401 Unauthorized

**Cause:** OAuth not configured correctly

**Solution:**
- Verify OAuth environment variables are set
- Check `/.well-known/oauth-authorization-server` endpoint returns valid metadata

### Wrong URL Map

**Important:** The active URL map is `mcp-url-map` (with hyphen). There may be an older `mcp-urlmap` (without hyphen) - always use the hyphenated version.

## Cost Considerations

Each MCP server adds approximately:
- **Cloud Run:** ~$8-12/month (with min_instances=1)
- **Backend Service:** Free (no charge for serverless NEGs)
- **NEG:** Free for serverless type
- **Load Balancer:** Shared (no additional per-path charge)

**Total per service:** ~$8-12/month

## References

- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [URL Map Configuration](https://cloud.google.com/load-balancing/docs/url-map)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
