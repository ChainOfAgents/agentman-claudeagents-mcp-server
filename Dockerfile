# MCP Server Dockerfile
# TypeScript with Node.js runtime
# Follows MCP 2025-11-25 specification with Streamable HTTP transport
# Based on the Agentman MCP server pattern

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ============================================================================
# Production image
# ============================================================================

FROM node:20-alpine

# Install curl for health checks
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy template YAML files (not compiled by tsc, needed at runtime)
COPY src/templates/ ./src/templates/

# Create non-root user (using GID/UID 1001 to avoid conflict with existing node user)
RUN addgroup -g 1001 mcpuser && \
    adduser -u 1001 -G mcpuser -s /bin/sh -D mcpuser && \
    chown -R mcpuser:mcpuser /app

USER mcpuser

# Expose the MCP server port
EXPOSE 8010

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8010/health || exit 1

# Set environment variables for production
ENV NODE_ENV=production \
    PORT=8010 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    MCP_TRANSPORT=http

# Run the server (uses MCP_TRANSPORT to select HTTP mode)
CMD ["node", "dist/index.js"]
