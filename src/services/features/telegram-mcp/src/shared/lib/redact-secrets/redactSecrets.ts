const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi, "Bearer [REDACTED]"],
  [/\bpostgres(?:ql)?:\/\/[^\s]+/gi, "postgres://[REDACTED]"],
  [/\bDATABASE_URL\s*=\s*[^\s]+/gi, "DATABASE_URL=[REDACTED]"],
  [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\b(?:password|passwd|pwd)\s*[:=]\s*[^\s'"]+/gi, "password=[REDACTED]"],
  [/\bapi[_-]?key\s*[:=]\s*[^\s'"]+/gi, "api_key=[REDACTED]"],
  [/\bsecret\s*[:=]\s*[^\s'"]+/gi, "secret=[REDACTED]"],
  [/\btoken\s*[:=]\s*[^\s'"]+/gi, "token=[REDACTED]"],
  [/\b[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\b/g, "[REDACTED_JWT]"],
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    input,
  );
}
