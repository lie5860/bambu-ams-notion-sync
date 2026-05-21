const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export function createLogger(levelName = "info") {
  const minLevel = levels[levelName] ?? levels.info;

  function write(level, args) {
    if ((levels[level] ?? levels.info) < minLevel) return;
    const time = new Date().toISOString();
    console[level === "debug" ? "log" : level](`[${time}] [${level.toUpperCase()}]`, ...args);
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args)
  };
}
