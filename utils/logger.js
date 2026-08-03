const winston = require('winston');
const path = require('path');
const chalk = require('chalk');

// Several provider APIs take the key as a URL query param (Gemini, Pixabay).
// When one of those calls fails, the axios error message embeds the full URL —
// key included — and that message gets logged, persisted to automation_events,
// and rendered in the dashboard's failures panel. Redact centrally so a
// credential can never leak into a log file, the database, or the UI.
const SECRET_PATTERNS = [
  /([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, // key in query string
  /\bAIza[0-9A-Za-z_-]{20,}/g,        // Google / Gemini
  /\bnvapi-[0-9A-Za-z_-]{20,}/g,      // NVIDIA NIM
  /\bsk-[0-9A-Za-z]{20,}/g,           // OpenAI-style
  /\bgh[pousr]_[0-9A-Za-z]{20,}/g,    // GitHub tokens
  /\bfreellmapi-[0-9a-f]{20,}/gi,     // local router key
  /\bya29\.[0-9A-Za-z_.-]{20,}/g,     // Google OAuth access token
  /\bGOCSPX-[0-9A-Za-z_-]{10,}/g      // Google OAuth client secret
];

function redactSecrets(value) {
  if (value == null) return value;
  let s = typeof value === 'string' ? value : String(value);
  for (const re of SECRET_PATTERNS) {
    // Only the query-string pattern has a capture group (the `?key=` prefix we
    // want to keep). For the rest, replace() passes the match offset as arg 2,
    // so guard on the type rather than truthiness.
    s = s.replace(re, (m, prefix) =>
      (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return s;
}

class Logger {
  constructor(component = 'System') {
    this.component = component;
    this.winston = this.createWinstonLogger();
  }

  createWinstonLogger() {
    const logDir = path.join(__dirname, '..', 'logs');
    
    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { component: this.component },
      transports: [
        // Write all logs to combined.log
        new winston.transports.File({ 
          filename: path.join(logDir, 'combined.log'),
          maxsize: 5242880, // 5MB
          maxFiles: 5,
        }),
        
        // Write error logs to error.log
        new winston.transports.File({ 
          filename: path.join(logDir, 'error.log'), 
          level: 'error',
          maxsize: 5242880, // 5MB
          maxFiles: 3,
        }),
        
        // Write agent-specific logs
        new winston.transports.File({
          filename: path.join(logDir, `${this.component.toLowerCase()}.log`),
          maxsize: 2097152, // 2MB
          maxFiles: 3,
        })
      ]
    });
  }

  info(message, ...args) {
    message = redactSecrets(message);
    this.winston.info(message, ...args);
    console.log(this.formatConsoleMessage('INFO', message, chalk.blue));
  }

  success(message, ...args) {
    message = redactSecrets(message);
    this.winston.info(message, ...args);
    console.log(this.formatConsoleMessage('SUCCESS', message, chalk.green));
  }

  warn(message, ...args) {
    message = redactSecrets(message);
    this.winston.warn(message, ...args);
    console.log(this.formatConsoleMessage('WARN', message, chalk.yellow));
  }

  error(message, error = null, ...args) {
    // `error` is sometimes a real Error object, sometimes just a string
    // (e.g. logger.error('X failed:', err.message)) — handle both so the
    // actual failure reason never gets silently dropped.
    message = redactSecrets(message);
    const errText = error ? redactSecrets(error.message || String(error)) : null;
    const errStack = (error && error.stack) ? redactSecrets(error.stack) : null;

    if (errText) {
      this.winston.error(message, { error: errText, stack: errStack, ...args });
    } else {
      this.winston.error(message, ...args);
    }
    const consoleMessage = errText ? `${message} ${errText}` : message;
    console.log(this.formatConsoleMessage('ERROR', consoleMessage, chalk.red));
    if (errStack && process.env.NODE_ENV !== 'production') {
      console.error(chalk.red(errStack));
    }
  }

  debug(message, ...args) {
    this.winston.debug(message, ...args);
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatConsoleMessage('DEBUG', message, chalk.gray));
    }
  }

  formatConsoleMessage(level, message, colorFunc) {
    const timestamp = new Date().toLocaleTimeString();
    const componentTag = chalk.cyan(`[${this.component}]`);
    const levelTag = colorFunc(`[${level}]`);
    
    return `${chalk.gray(timestamp)} ${componentTag} ${levelTag} ${message}`;
  }

  // Method to create specialized loggers for different purposes
  static createAgentLogger(agentName) {
    return new Logger(agentName);
  }

  static createSystemLogger() {
    return new Logger('System');
  }

  static createAPILogger() {
    return new Logger('API');
  }

  // Performance logging
  startTimer(label) {
    const startTime = Date.now();
    return {
      end: () => {
        const duration = Date.now() - startTime;
        this.info(`${label} completed in ${duration}ms`);
        return duration;
      }
    };
  }

  // Structured logging for important events
  logEvent(eventType, data = {}) {
    this.winston.info('System Event', {
      eventType,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  // Log content generation pipeline
  logContentPipeline(stage, contentId, status, data = {}) {
    this.winston.info('Content Pipeline', {
      stage,
      contentId,
      status,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  // Log publishing events
  logPublishing(action, videoId, status, data = {}) {
    this.winston.info('Publishing Event', {
      action,
      videoId,
      status,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  // Log analytics events
  logAnalytics(videoId, metrics, insights = []) {
    this.winston.info('Analytics Update', {
      videoId,
      metrics,
      insights,
      timestamp: new Date().toISOString()
    });
  }

  // Log errors with context
  logErrorWithContext(error, context = {}) {
    this.winston.error('System Error', {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      context,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = { Logger, redactSecrets };