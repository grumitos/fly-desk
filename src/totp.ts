const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const COSTAMAR_TOTP_LABEL_PATTERN = /costamar|click\s*&?\s*book|clickandbook/i;
const TOTP_JSON_HINT_PATTERN = /totp|otp|auth|secret|uri/i;

interface TotpConfig {
  key: Buffer;
  digits: number;
  period: number;
  algorithm: "sha1" | "sha256" | "sha512";
}

interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: number | Buffer;
}

interface MigrationOtpParameters {
  secret?: Buffer;
  name?: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
}

function decodeBase32(input: string): Buffer {
  const normalized = input
    .trim()
    .replace(/\s+/g, "")
    .replace(/=+$/g, "")
    .toUpperCase();

  let bits = "";
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid Base32 secret.");
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64");
}

function looksLikeBase32Secret(input: string): boolean {
  return /^[A-Z2-7]+=*$/i.test(input.trim());
}

function sanitizeEmbeddedTotpUri(input: string): string {
  return input.trim().replace(/[)"',;]+$/g, "");
}

function extractTotpValueFromJson(value: unknown, hint = ""): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^otpauth(?:-migration)?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    if (looksLikeBase32Secret(trimmed) && TOTP_JSON_HINT_PATTERN.test(hint)) {
      return trimmed;
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = extractTotpValueFromJson(entry, hint);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const prioritizedKeys = [
    "totpUri",
    "totp",
    "otpUri",
    "otpauth",
    "otpauthUri",
    "otpSecret",
    "totpSecret",
    "secret",
  ];

  for (const key of prioritizedKeys) {
    if (!(key in record)) {
      continue;
    }

    const candidate = extractTotpValueFromJson(record[key], key);
    if (candidate) {
      return candidate;
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    const candidate = extractTotpValueFromJson(entry, key);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function extractTotpSource(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("TOTP secret is empty.");
  }

  const embeddedUriMatch = trimmed.match(/otpauth(?:-migration)?:\/\/\S+/i);
  if (embeddedUriMatch) {
    return sanitizeEmbeddedTotpUri(embeddedUriMatch[0]);
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const embedded = extractTotpValueFromJson(parsed);
      if (embedded) {
        return embedded;
      }
    } catch {
      // Fall back to treating the input as a direct secret.
    }
  }

  return trimmed;
}

function readVarint(buffer: Buffer, start: number): { value: number; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let offset = start;

  while (offset < buffer.length) {
    const byte = BigInt(buffer[offset]);
    result |= (byte & 0x7fn) << shift;
    offset += 1;
    if ((byte & 0x80n) === 0n) {
      const numeric = Number(result);
      if (!Number.isSafeInteger(numeric)) {
        throw new Error("Unsupported protobuf varint size.");
      }
      return {
        value: numeric,
        nextOffset: offset,
      };
    }
    shift += 7n;
  }

  throw new Error("Unexpected end of protobuf varint.");
}

function parseProtoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.nextOffset;

    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 0x07;
    if (fieldNumber <= 0) {
      throw new Error("Invalid protobuf field number.");
    }

    if (wireType === 0) {
      const fieldValue = readVarint(buffer, offset);
      offset = fieldValue.nextOffset;
      fields.push({
        fieldNumber,
        wireType,
        value: fieldValue.value,
      });
      continue;
    }

    if (wireType === 2) {
      const lengthValue = readVarint(buffer, offset);
      offset = lengthValue.nextOffset;
      const endOffset = offset + lengthValue.value;
      if (endOffset > buffer.length) {
        throw new Error("Invalid protobuf length-delimited field.");
      }
      fields.push({
        fieldNumber,
        wireType,
        value: buffer.subarray(offset, endOffset),
      });
      offset = endOffset;
      continue;
    }

    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }

  return fields;
}

function decodeMigrationOtpParameters(buffer: Buffer): MigrationOtpParameters {
  const result: MigrationOtpParameters = {};

  for (const field of parseProtoFields(buffer)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.secret = field.value as Buffer;
      continue;
    }
    if (field.fieldNumber === 2 && field.wireType === 2) {
      result.name = (field.value as Buffer).toString("utf8");
      continue;
    }
    if (field.fieldNumber === 3 && field.wireType === 2) {
      result.issuer = (field.value as Buffer).toString("utf8");
      continue;
    }
    if (field.fieldNumber === 4 && field.wireType === 0) {
      result.algorithm = field.value as number;
      continue;
    }
    if (field.fieldNumber === 5 && field.wireType === 0) {
      result.digits = field.value as number;
      continue;
    }
    if (field.fieldNumber === 6 && field.wireType === 0) {
      result.type = field.value as number;
    }
  }

  return result;
}

function decodeMigrationAlgorithm(value?: number): "sha1" | "sha256" | "sha512" {
  switch (value) {
    case 2:
      return "sha256";
    case 3:
      return "sha512";
    default:
      return "sha1";
  }
}

function decodeMigrationDigits(value?: number): number {
  switch (value) {
    case 2:
      return 8;
    default:
      return 6;
  }
}

function parseOtpauthUri(input: string): TotpConfig {
  const uri = new URL(input);
  const secret = uri.searchParams.get("secret")?.trim() ?? "";
  if (!secret) {
    throw new Error("otpauth URI has no secret.");
  }

  const digits = Math.max(6, Number.parseInt(uri.searchParams.get("digits") ?? "6", 10) || 6);
  const period = Math.max(1, Number.parseInt(uri.searchParams.get("period") ?? "30", 10) || 30);
  const algorithmRaw = (uri.searchParams.get("algorithm") ?? "SHA1").trim().toLowerCase();
  const algorithm = algorithmRaw === "sha256" || algorithmRaw === "sha512"
    ? algorithmRaw
    : "sha1";

  return {
    key: decodeBase32(secret),
    digits,
    period,
    algorithm,
  };
}

function parseOtpauthMigrationUri(input: string): TotpConfig {
  const uri = new URL(input);
  const data = uri.searchParams.get("data")?.trim() ?? "";
  if (!data) {
    throw new Error("otpauth-migration URI has no data payload.");
  }

  const payload = decodeBase64Url(data);
  const entries = parseProtoFields(payload)
    .filter((field) => field.fieldNumber === 1 && field.wireType === 2)
    .map((field) => decodeMigrationOtpParameters(field.value as Buffer))
    .filter((entry) => entry.secret && entry.secret.length > 0)
    .filter((entry) => entry.type === undefined || entry.type === 0 || entry.type === 2);

  if (entries.length === 0) {
    throw new Error("otpauth-migration payload has no usable TOTP entries.");
  }

  const preferredEntry = entries.find((entry) =>
    COSTAMAR_TOTP_LABEL_PATTERN.test(`${entry.issuer ?? ""} ${entry.name ?? ""}`),
  ) ?? entries[0];

  return {
    key: preferredEntry.secret as Buffer,
    digits: decodeMigrationDigits(preferredEntry.digits),
    period: 30,
    algorithm: decodeMigrationAlgorithm(preferredEntry.algorithm),
  };
}

function normalizeTotpSecretInput(input: string): TotpConfig {
  const source = extractTotpSource(input);
  if (/^otpauth-migration:\/\//i.test(source)) {
    return parseOtpauthMigrationUri(source);
  }

  if (/^otpauth:\/\//i.test(source)) {
    return parseOtpauthUri(source);
  }

  return {
    key: decodeBase32(source),
    digits: 6,
    period: 30,
    algorithm: "sha1",
  };
}

export interface TotpCodeResult {
  code: string;
  periodSeconds: number;
  remainingSeconds: number;
}

export function totpCanSubmitSafely(
  nowMs: number,
  periodSeconds: number,
  minRemainingSeconds: number,
): boolean {
  const period = Math.max(1, Math.trunc(periodSeconds));
  const minRemaining = Math.max(0, Math.trunc(minRemainingSeconds));
  const elapsedSeconds = Math.floor(nowMs / 1000) % period;
  const remainingSeconds = period - elapsedSeconds;
  return remainingSeconds >= minRemaining;
}

export function generateTotpCodeWithMetadata(secretInput: string, nowMs = Date.now()): TotpCodeResult {
  const { key, digits, period, algorithm } = normalizeTotpSecretInput(secretInput);
  const counter = Math.floor(nowMs / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = new Bun.CryptoHasher(algorithm, key);
  hmac.update(counterBuffer);
  const digest = hmac.digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;

  const mod = 10 ** digits;
  const elapsedSeconds = Math.floor(nowMs / 1000) % period;
  return {
    code: String(truncated % mod).padStart(digits, "0"),
    periodSeconds: period,
    remainingSeconds: period - elapsedSeconds,
  };
}

export function generateTotpCode(secretInput: string, nowMs = Date.now()): string {
  return generateTotpCodeWithMetadata(secretInput, nowMs).code;
}
