function frontendHostname() {
  return typeof window === "undefined" ? "" : window.location.hostname;
}

function printableHostname(hostname: string) {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

export function withFrontendHostname(value: string, hostname = frontendHostname()) {
  if (!value || !hostname) return value;
  try {
    const parsed = new URL(value);
    const hadRootSlash = value.endsWith("/");
    parsed.hostname = hostname;
    const rewritten = parsed.toString();
    return !hadRootSlash && parsed.pathname === "/" && !parsed.search && !parsed.hash
      ? rewritten.replace(/\/$/, "")
      : rewritten;
  } catch {
    return value;
  }
}

export function frontendHostPort(originalHost: string, port: number, hostname = frontendHostname()) {
  return `${printableHostname(hostname || originalHost)}:${port}`;
}

export function commandWithFrontendHostname(command: string, hostname = frontendHostname()) {
  if (!command || !hostname) return command;
  return command.replace(
    /(--manager-url=)(https?:\/\/[^\s]+)/i,
    (_match, prefix: string, managerUrl: string) =>
      `${prefix}${withFrontendHostname(managerUrl, hostname)}`
  );
}
