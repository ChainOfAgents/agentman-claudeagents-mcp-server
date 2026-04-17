/**
 * Structured Logger
 *
 * Simple logging utility that respects LOG_LEVEL configuration.
 * Supports request ID correlation for distributed tracing.
 */

import { config } from "../config.js";

// =============================================================================
// Types
// =============================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  requestId?: string;
  [key: string]: unknown;
}

// =============================================================================
// Log Level Hierarchy
// =============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = config.logLevel as LogLevel;
  return LOG_LEVELS[level] >= LOG_LEVELS[configuredLevel];
}

// =============================================================================
// Formatting
// =============================================================================

function formatMessage(
  level: LogLevel,
  message: string,
  context?: LogContext
): string {
  const timestamp = new Date().toISOString();
  const prefix = context?.requestId ? `[${context.requestId}]` : "";
  const levelTag = level.toUpperCase().padEnd(5);

  // Remove requestId from context for display (already in prefix)
  const displayContext = context ? { ...context } : undefined;
  if (displayContext?.requestId) {
    delete displayContext.requestId;
  }

  const contextStr =
    displayContext && Object.keys(displayContext).length > 0
      ? ` ${JSON.stringify(displayContext)}`
      : "";

  return `${timestamp} ${levelTag} ${prefix} ${message}${contextStr}`;
}

// =============================================================================
// Logger Instance
// =============================================================================

export const logger = {
  /**
   * Debug level - verbose information for development
   */
  debug(message: string, context?: LogContext): void {
    if (shouldLog("debug")) {
      console.log(formatMessage("debug", message, context));
    }
  },

  /**
   * Info level - general operational information
   */
  info(message: string, context?: LogContext): void {
    if (shouldLog("info")) {
      console.log(formatMessage("info", message, context));
    }
  },

  /**
   * Warn level - potentially problematic situations
   */
  warn(message: string, context?: LogContext): void {
    if (shouldLog("warn")) {
      console.warn(formatMessage("warn", message, context));
    }
  },

  /**
   * Error level - error conditions
   */
  error(message: string, context?: LogContext): void {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message, context));
    }
  },

  /**
   * Create a child logger with preset context (e.g., requestId)
   */
  child(baseContext: LogContext) {
    return {
      debug: (message: string, context?: LogContext) =>
        logger.debug(message, { ...baseContext, ...context }),
      info: (message: string, context?: LogContext) =>
        logger.info(message, { ...baseContext, ...context }),
      warn: (message: string, context?: LogContext) =>
        logger.warn(message, { ...baseContext, ...context }),
      error: (message: string, context?: LogContext) =>
        logger.error(message, { ...baseContext, ...context }),
    };
  },
};

export default logger;
