/**
 * Production-ready logger utility
 * Logs are disabled in production environment
 */

const isDevelopment = process.env.NODE_ENV === "development";

export const logger = {
  log: (...args: any[]) => {
    if (isDevelopment) {
      // console.log(...args);
}
  },
  error: (...args: any[]) => {
    // Always log errors, even in production
    console.error(...args);
  },
  warn: (...args: any[]) => {
    if (isDevelopment) {
      // console.warn(...args);
}
  },
  info: (...args: any[]) => {
    if (isDevelopment) {
      // console.info(...args);
}
  },
  debug: (...args: any[]) => {
    if (isDevelopment) {
      // console.debug(...args);
}
  },
};

