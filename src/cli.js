import { Command } from "commander";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const CLI_CONFIG_PATH = join(homedir(), ".justcalendar-cli", "config.json");
const DEFAULT_BASE_URL = "https://justcalendar.ai";

const DRIVE_FILES_API_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API_URL = "https://www.googleapis.com/upload/drive/v3/files";
const JUSTCALENDAR_FOLDER_NAME = "JustCalendar.ai";
const JUSTCALENDAR_CONFIG_FILE_NAME = "justcalendar.json";

const DEFAULT_THEME = "tokyo-night-storm";
const DEFAULT_ACCOUNT_NAME = "default";

const CALENDAR_TYPES = new Set(["signal-3", "score", "check", "notes"]);
const CALENDAR_COLORS = new Set(["green", "red", "orange", "yellow", "cyan", "blue"]);
const SCORE_DISPLAYS = new Set(["number", "heatmap", "number-heatmap"]);
const SIGNAL_DAY_VALUES = new Set(["red", "yellow", "green", "x"]);

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ID_CHARSET_SIZE = ID_ALPHABET.length;
const ID_LENGTH = 22;

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(rawUrl) {
  const candidate = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!candidate) {
    return DEFAULT_BASE_URL;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL: ${candidate}`);
  }
  if (!parsed.protocol || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("Base URL must use http:// or https://");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const normalized = parsed.toString().replace(/\/$/, "");
  return normalized;
}

function normalizeAgentToken(rawToken) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) {
    return "";
  }
  return /^jca_[A-Za-z0-9_-]{24,256}$/.test(token) ? token : "";
}

function safeJsonStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readCliConfig() {
  try {
    const raw = await fs.readFile(CLI_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!isObjectRecord(parsed)) {
      return {
        baseUrl: DEFAULT_BASE_URL,
      };
    }
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl || DEFAULT_BASE_URL),
      agentToken: normalizeAgentToken(parsed.agentToken || ""),
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : "",
      accessTokenExpiresAt: Number.isFinite(Number(parsed.accessTokenExpiresAt))
        ? Number(parsed.accessTokenExpiresAt)
        : 0,
      tokenType: typeof parsed.tokenType === "string" && parsed.tokenType.trim()
        ? parsed.tokenType.trim()
        : "Bearer",
    };
  } catch {
    return {
      baseUrl: DEFAULT_BASE_URL,
    };
  }
}

async function writeCliConfig(config) {
  const normalized = {
    baseUrl: normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL),
    agentToken: normalizeAgentToken(config.agentToken || ""),
    accessToken: typeof config.accessToken === "string" ? config.accessToken : "",
    accessTokenExpiresAt: Number.isFinite(Number(config.accessTokenExpiresAt))
      ? Number(config.accessTokenExpiresAt)
      : 0,
    tokenType: typeof config.tokenType === "string" && config.tokenType.trim()
      ? config.tokenType.trim()
      : "Bearer",
  };

  await fs.mkdir(dirname(CLI_CONFIG_PATH), { recursive: true });
  await fs.writeFile(CLI_CONFIG_PATH, safeJsonStringify(normalized), "utf8");
  try {
    await fs.chmod(CLI_CONFIG_PATH, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
}

async function parseJsonResponse(response) {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const textPayload = await response.text();
      if (!textPayload) {
        return null;
      }
      try {
        return JSON.parse(textPayload);
      } catch {
        return { raw: textPayload };
      }
    }
    return await response.json();
  } catch {
    return null;
  }
}

function clearCachedAccessToken(cliConfig) {
  cliConfig.accessToken = "";
  cliConfig.accessTokenExpiresAt = 0;
  cliConfig.tokenType = "Bearer";
}

function requireAgentToken(cliConfig) {
  const token = normalizeAgentToken(cliConfig.agentToken || "");
  if (!token) {
    throw new Error("Not logged in. Run: justcalendar login --token <agent-token>");
  }
  return token;
}

async function ensureBackendAccessToken(cliConfig, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (
    !forceRefresh &&
    typeof cliConfig.accessToken === "string" &&
    cliConfig.accessToken.trim() &&
    Number(cliConfig.accessTokenExpiresAt) > now + 60_000
  ) {
    return {
      accessToken: cliConfig.accessToken,
      tokenType: cliConfig.tokenType || "Bearer",
      expiresAt: Number(cliConfig.accessTokenExpiresAt),
    };
  }

  const agentToken = requireAgentToken(cliConfig);
  const endpoint = `${normalizeBaseUrl(cliConfig.baseUrl || DEFAULT_BASE_URL)}/api/auth/google/agent-token/access-token`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
  });
  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload?.ok || typeof payload?.accessToken !== "string" || !payload.accessToken.trim()) {
    if (response.status === 401 || response.status === 403) {
      clearCachedAccessToken(cliConfig);
      await writeCliConfig(cliConfig);
    }
    const errorMessage = payload?.message || payload?.error || `status_${response.status}`;
    throw new Error(`Failed to get access token from backend: ${errorMessage}`);
  }

  cliConfig.accessToken = payload.accessToken.trim();
  cliConfig.accessTokenExpiresAt = Number.isFinite(Number(payload.expiresAt))
    ? Number(payload.expiresAt)
    : Date.now() + 55 * 60 * 1000;
  cliConfig.tokenType =
    typeof payload.tokenType === "string" && payload.tokenType.trim() ? payload.tokenType.trim() : "Bearer";
  await writeCliConfig(cliConfig);

  return {
    accessToken: cliConfig.accessToken,
    tokenType: cliConfig.tokenType,
    expiresAt: cliConfig.accessTokenExpiresAt,
  };
}

async function driveFetchJson(
  cliConfig,
  url,
  {
    method = "GET",
    headers = {},
    body,
    retryUnauthorized = true,
  } = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { accessToken } = await ensureBackendAccessToken(cliConfig, {
      forceRefresh: attempt > 0,
    });

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...headers,
      },
      body,
    });
    const payload = await parseJsonResponse(response);

    if (response.status === 401 && retryUnauthorized && attempt === 0) {
      clearCachedAccessToken(cliConfig);
      await writeCliConfig(cliConfig);
      continue;
    }

    return { response, payload };
  }

  throw new Error("Failed to call Google Drive API due to repeated authorization errors.");
}

function ensureDriveSuccess(result, contextLabel) {
  if (result.response.ok) {
    return;
  }
  const details = result.payload?.error || result.payload || result.response.statusText || "unknown_error";
  throw new Error(`${contextLabel} failed (${result.response.status}): ${JSON.stringify(details)}`);
}

function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildDriveFilesListUrl({
  query,
  fields = "files(id,name,mimeType,parents,createdTime)",
  pageSize = 100,
} = {}) {
  const url = new URL(DRIVE_FILES_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("fields", fields);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("includeItemsFromAllDrives", "false");
  url.searchParams.set("supportsAllDrives", "false");
  url.searchParams.set("orderBy", "createdTime asc");
  return url;
}

async function listDriveFiles(cliConfig, { query, fields, pageSize } = {}) {
  const listUrl = buildDriveFilesListUrl({ query, fields, pageSize });
  const result = await driveFetchJson(cliConfig, listUrl, {
    method: "GET",
  });
  ensureDriveSuccess(result, "Google Drive list files");
  const files = Array.isArray(result.payload?.files) ? result.payload.files : [];
  return files;
}

async function ensureJustCalendarFolder(cliConfig) {
  const escapedName = escapeDriveQueryValue(JUSTCALENDAR_FOLDER_NAME);
  const query = `name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const existingFolders = await listDriveFiles(cliConfig, {
    query,
    fields: "files(id,name,mimeType,createdTime)",
    pageSize: 10,
  });

  if (existingFolders.length > 0 && typeof existingFolders[0].id === "string") {
    return existingFolders[0].id;
  }

  const createResult = await driveFetchJson(cliConfig, `${DRIVE_FILES_API_URL}?fields=id,name,mimeType`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: JUSTCALENDAR_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  ensureDriveSuccess(createResult, "Google Drive create JustCalendar.ai folder");

  const folderId = typeof createResult.payload?.id === "string" ? createResult.payload.id.trim() : "";
  if (!folderId) {
    throw new Error("Drive folder creation succeeded but no folder id was returned.");
  }
  return folderId;
}

async function findFileByNameInFolder(cliConfig, { folderId, fileName }) {
  const escapedFolderId = escapeDriveQueryValue(folderId);
  const escapedFileName = escapeDriveQueryValue(fileName);
  const query = `name = '${escapedFileName}' and '${escapedFolderId}' in parents and trashed = false`;
  const files = await listDriveFiles(cliConfig, {
    query,
    fields: "files(id,name,mimeType,parents,createdTime)",
    pageSize: 10,
  });

  if (files.length === 0) {
    return null;
  }

  const firstFile = files[0];
  if (!firstFile || typeof firstFile.id !== "string") {
    return null;
  }

  return {
    id: firstFile.id,
    name: typeof firstFile.name === "string" ? firstFile.name : fileName,
    mimeType: typeof firstFile.mimeType === "string" ? firstFile.mimeType : "",
  };
}

async function readDriveJsonFileById(cliConfig, fileId) {
  const readUrl = `${DRIVE_FILES_API_URL}/${encodeURIComponent(fileId)}?alt=media`;
  const result = await driveFetchJson(cliConfig, readUrl, {
    method: "GET",
  });
  if (result.response.status === 404) {
    return {
      found: false,
      payload: null,
    };
  }
  ensureDriveSuccess(result, "Google Drive read JSON file");

  if (!isObjectRecord(result.payload)) {
    throw new Error(`File ${fileId} did not contain a JSON object.`);
  }

  return {
    found: true,
    payload: result.payload,
  };
}

function createMultipartJsonBody({ metadata, payload }) {
  const boundary = `justcalendar_cli_${randomBytes(12).toString("hex")}`;
  const delimiter = `--${boundary}`;
  const closeDelimiter = `--${boundary}--`;

  const body = [
    delimiter,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    delimiter,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(payload),
    closeDelimiter,
    "",
  ].join("\r\n");

  return {
    boundary,
    body,
  };
}

async function createDriveJsonFile(cliConfig, { folderId, fileName, payload }) {
  const { boundary, body } = createMultipartJsonBody({
    metadata: {
      name: fileName,
      parents: [folderId],
      mimeType: "application/json",
    },
    payload,
  });

  const createUrl = `${DRIVE_UPLOAD_API_URL}?uploadType=multipart&fields=id,name,mimeType,parents`;
  const result = await driveFetchJson(cliConfig, createUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  ensureDriveSuccess(result, `Google Drive create file ${fileName}`);

  const createdId = typeof result.payload?.id === "string" ? result.payload.id.trim() : "";
  if (!createdId) {
    throw new Error(`Drive file create for ${fileName} returned no file id.`);
  }

  return {
    fileId: createdId,
  };
}

async function updateDriveJsonFile(cliConfig, { fileId, payload }) {
  const updateUrl = `${DRIVE_UPLOAD_API_URL}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,parents`;
  const result = await driveFetchJson(cliConfig, updateUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(payload),
  });
  ensureDriveSuccess(result, `Google Drive update file ${fileId}`);

  return {
    fileId: typeof result.payload?.id === "string" ? result.payload.id.trim() : fileId,
  };
}

async function upsertDriveJsonFileByName(cliConfig, { folderId, fileName, payload, fileId = "" }) {
  const normalizedFileId = typeof fileId === "string" ? fileId.trim() : "";
  if (normalizedFileId) {
    const updateResult = await updateDriveJsonFile(cliConfig, {
      fileId: normalizedFileId,
      payload,
    });
    return {
      fileId: updateResult.fileId,
      created: false,
    };
  }

  const existing = await findFileByNameInFolder(cliConfig, { folderId, fileName });
  if (existing?.id) {
    const updateResult = await updateDriveJsonFile(cliConfig, {
      fileId: existing.id,
      payload,
    });
    return {
      fileId: updateResult.fileId,
      created: false,
    };
  }

  const createResult = await createDriveJsonFile(cliConfig, {
    folderId,
    fileName,
    payload,
  });
  return {
    fileId: createResult.fileId,
    created: true,
  };
}

async function deleteDriveFileById(cliConfig, fileId) {
  if (!fileId) {
    return;
  }

  const deleteUrl = `${DRIVE_FILES_API_URL}/${encodeURIComponent(fileId)}?supportsAllDrives=false`;
  const result = await driveFetchJson(cliConfig, deleteUrl, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
    },
  });

  if (result.response.status === 404) {
    return;
  }
  if (!result.response.ok) {
    const details = result.payload?.error || result.payload || result.response.statusText || "unknown_error";
    throw new Error(`Google Drive delete file ${fileId} failed (${result.response.status}): ${JSON.stringify(details)}`);
  }
}

function createHighEntropyId(length = ID_LENGTH) {
  const tokenLength = Number.isInteger(length) && length > 0 ? length : ID_LENGTH;
  let nextId = "";
  while (nextId.length < tokenLength) {
    const randomChunk = randomBytes(Math.max(tokenLength * 2, 16));
    for (const rawByte of randomChunk) {
      if (rawByte >= 248) {
        continue;
      }
      nextId += ID_ALPHABET[rawByte % ID_CHARSET_SIZE];
      if (nextId.length >= tokenLength) {
        break;
      }
    }
  }
  return nextId;
}

function normalizeCalendarType(rawType, fallback = "check") {
  const nextType = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  return CALENDAR_TYPES.has(nextType) ? nextType : fallback;
}

function normalizeCalendarColor(rawColor, fallback = "blue") {
  const nextColor = typeof rawColor === "string" ? rawColor.trim().toLowerCase() : "";
  return CALENDAR_COLORS.has(nextColor) ? nextColor : fallback;
}

function normalizeScoreDisplay(rawDisplay, fallback = "number") {
  const nextDisplay = typeof rawDisplay === "string" ? rawDisplay.trim().toLowerCase() : "";
  return SCORE_DISPLAYS.has(nextDisplay) ? nextDisplay : fallback;
}

function normalizeName(rawName, fallback = "Unnamed") {
  const normalized = String(rawName ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function flattenNestedDayData(nestedData) {
  if (!isObjectRecord(nestedData)) {
    return {};
  }

  const flatData = {};
  for (const [rawYear, rawYearValue] of Object.entries(nestedData)) {
    const year = String(rawYear ?? "").trim();
    if (!/^\d{4}$/.test(year) || !isObjectRecord(rawYearValue)) {
      continue;
    }

    for (const [rawMonth, rawMonthValue] of Object.entries(rawYearValue)) {
      const month = String(rawMonth ?? "").trim();
      if (!/^\d{2}$/.test(month) || !isObjectRecord(rawMonthValue)) {
        continue;
      }

      for (const [rawDay, rawDayValue] of Object.entries(rawMonthValue)) {
        const day = String(rawDay ?? "").trim();
        if (!/^\d{2}$/.test(day)) {
          continue;
        }
        flatData[`${year}-${month}-${day}`] = rawDayValue;
      }
    }
  }

  return flatData;
}

function toNestedDayData(flatData) {
  if (!isObjectRecord(flatData)) {
    return {};
  }

  const nested = {};
  const sortedEntries = Object.entries(flatData).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  for (const [dayKey, dayValue] of sortedEntries) {
    const dayKeyMatch = String(dayKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dayKeyMatch) {
      continue;
    }
    const [, year, month, day] = dayKeyMatch;
    if (!nested[year]) {
      nested[year] = {};
    }
    if (!nested[year][month]) {
      nested[year][month] = {};
    }
    nested[year][month][day] = dayValue;
  }

  return nested;
}

function createDefaultWorkspacePayload() {
  const accountId = createHighEntropyId();
  const calendarId = createHighEntropyId();
  const calendarFileName = `${accountId}_${calendarId}.json`;

  const calendar = {
    id: calendarId,
    name: "Default Calendar",
    type: "check",
    color: "blue",
    pinned: false,
    "data-file": calendarFileName,
  };

  const configPayload = {
    version: 1,
    "current-account-id": accountId,
    "current-calendar-id": calendarId,
    "selected-theme": DEFAULT_THEME,
    accounts: {
      [accountId]: {
        id: accountId,
        name: DEFAULT_ACCOUNT_NAME,
        calendars: [calendar],
      },
    },
  };

  const calendarDataPayload = {
    version: 1,
    "account-id": accountId,
    "calendar-id": calendarId,
    "calendar-type": "check",
    data: {},
  };

  return {
    accountId,
    calendar,
    configPayload,
    calendarDataPayload,
  };
}

function normalizeConfigInPlace(configPayload) {
  let didMutate = false;

  const payload = isObjectRecord(configPayload) ? configPayload : {};
  if (!isObjectRecord(configPayload)) {
    didMutate = true;
  }

  if (!isObjectRecord(payload.accounts)) {
    payload.accounts = {};
    didMutate = true;
  }

  const accountEntries = Object.entries(payload.accounts).filter(
    ([accountId, accountRecord]) => typeof accountId === "string" && accountId.trim() && isObjectRecord(accountRecord),
  );

  if (accountEntries.length === 0) {
    const bootstrap = createDefaultWorkspacePayload();
    Object.assign(payload, bootstrap.configPayload);
    return {
      config: payload,
      currentAccountId: bootstrap.accountId,
      currentAccount: payload.accounts[bootstrap.accountId],
      didMutate: true,
      bootstrapped: bootstrap,
    };
  }

  let currentAccountId =
    typeof payload["current-account-id"] === "string" && payload["current-account-id"].trim()
      ? payload["current-account-id"].trim()
      : "";

  if (!currentAccountId || !isObjectRecord(payload.accounts[currentAccountId])) {
    currentAccountId = accountEntries[0][0].trim();
    payload["current-account-id"] = currentAccountId;
    didMutate = true;
  }

  const currentAccount = payload.accounts[currentAccountId];
  if (typeof currentAccount.id !== "string" || !currentAccount.id.trim()) {
    currentAccount.id = currentAccountId;
    didMutate = true;
  }
  if (typeof currentAccount.name !== "string" || !currentAccount.name.trim()) {
    currentAccount.name = DEFAULT_ACCOUNT_NAME;
    didMutate = true;
  }
  if (!Array.isArray(currentAccount.calendars)) {
    currentAccount.calendars = [];
    didMutate = true;
  }

  const usedCalendarIds = new Set();
  const normalizedCalendars = [];
  for (const [index, rawCalendar] of currentAccount.calendars.entries()) {
    if (!isObjectRecord(rawCalendar)) {
      didMutate = true;
      continue;
    }
    const nextCalendarIdCandidate =
      typeof rawCalendar.id === "string" && rawCalendar.id.trim() ? rawCalendar.id.trim() : "";
    const nextCalendarId =
      nextCalendarIdCandidate && !usedCalendarIds.has(nextCalendarIdCandidate)
        ? nextCalendarIdCandidate
        : createHighEntropyId();

    if (nextCalendarId !== nextCalendarIdCandidate) {
      didMutate = true;
    }
    usedCalendarIds.add(nextCalendarId);

    const nextCalendarType = normalizeCalendarType(rawCalendar.type, "check");
    const nextCalendar = {
      id: nextCalendarId,
      name: normalizeName(rawCalendar.name, `Calendar ${index + 1}`),
      type: nextCalendarType,
      color: normalizeCalendarColor(rawCalendar.color, "blue"),
      pinned: Boolean(rawCalendar.pinned),
      "data-file":
        typeof rawCalendar["data-file"] === "string" && rawCalendar["data-file"].trim()
          ? rawCalendar["data-file"].trim()
          : `${currentAccountId}_${nextCalendarId}.json`,
      ...(nextCalendarType === "score"
        ? { display: normalizeScoreDisplay(rawCalendar.display, "number") }
        : {}),
      ...(typeof rawCalendar["data-file-id"] === "string" && rawCalendar["data-file-id"].trim()
        ? { "data-file-id": rawCalendar["data-file-id"].trim() }
        : {}),
    };

    if (
      nextCalendar.name !== rawCalendar.name ||
      nextCalendar.type !== rawCalendar.type ||
      nextCalendar.color !== rawCalendar.color ||
      nextCalendar.pinned !== Boolean(rawCalendar.pinned) ||
      nextCalendar["data-file"] !== rawCalendar["data-file"] ||
      (nextCalendarType === "score" && nextCalendar.display !== rawCalendar.display)
    ) {
      didMutate = true;
    }

    normalizedCalendars.push(nextCalendar);
  }

  if (normalizedCalendars.length === 0) {
    const defaultCalendarId = createHighEntropyId();
    normalizedCalendars.push({
      id: defaultCalendarId,
      name: "Default Calendar",
      type: "check",
      color: "blue",
      pinned: false,
      "data-file": `${currentAccountId}_${defaultCalendarId}.json`,
    });
    didMutate = true;
  }

  currentAccount.calendars = normalizedCalendars;

  const currentCalendarIdCandidate =
    typeof payload["current-calendar-id"] === "string" ? payload["current-calendar-id"].trim() : "";
  const hasCurrentCalendar = normalizedCalendars.some((calendar) => calendar.id === currentCalendarIdCandidate);
  if (!hasCurrentCalendar) {
    payload["current-calendar-id"] = normalizedCalendars[0].id;
    didMutate = true;
  }

  const selectedThemeCandidate =
    typeof payload["selected-theme"] === "string" && payload["selected-theme"].trim()
      ? payload["selected-theme"].trim().toLowerCase()
      : "";
  if (!selectedThemeCandidate) {
    payload["selected-theme"] = DEFAULT_THEME;
    didMutate = true;
  }

  if (!Number.isFinite(Number(payload.version)) || Number(payload.version) !== 1) {
    payload.version = 1;
    didMutate = true;
  }

  return {
    config: payload,
    currentAccountId,
    currentAccount,
    didMutate,
    bootstrapped: null,
  };
}

async function loadWorkspace(cliConfig, { createConfigIfMissing = true } = {}) {
  const folderId = await ensureJustCalendarFolder(cliConfig);
  const configMeta = await findFileByNameInFolder(cliConfig, {
    folderId,
    fileName: JUSTCALENDAR_CONFIG_FILE_NAME,
  });

  if (!configMeta) {
    if (!createConfigIfMissing) {
      throw new Error("justcalendar.json not found in JustCalendar.ai folder.");
    }

    const bootstrap = createDefaultWorkspacePayload();
    const createdDataFile = await createDriveJsonFile(cliConfig, {
      folderId,
      fileName: bootstrap.calendar["data-file"],
      payload: bootstrap.calendarDataPayload,
    });

    bootstrap.configPayload.accounts[bootstrap.accountId].calendars[0]["data-file-id"] =
      createdDataFile.fileId;

    const createdConfigFile = await createDriveJsonFile(cliConfig, {
      folderId,
      fileName: JUSTCALENDAR_CONFIG_FILE_NAME,
      payload: bootstrap.configPayload,
    });

    return {
      folderId,
      configFileId: createdConfigFile.fileId,
      configPayload: bootstrap.configPayload,
    };
  }

  const configRead = await readDriveJsonFileById(cliConfig, configMeta.id);
  if (!configRead.found || !isObjectRecord(configRead.payload)) {
    throw new Error("justcalendar.json was found but could not be parsed.");
  }

  const normalized = normalizeConfigInPlace(configRead.payload);
  if (normalized.didMutate) {
    await updateDriveJsonFile(cliConfig, {
      fileId: configMeta.id,
      payload: normalized.config,
    });
  }

  if (normalized.bootstrapped) {
    const firstCalendar = normalized.currentAccount.calendars[0];
    const createResult = await upsertDriveJsonFileByName(cliConfig, {
      folderId,
      fileName: firstCalendar["data-file"],
      payload: {
        version: 1,
        "account-id": normalized.currentAccountId,
        "calendar-id": firstCalendar.id,
        "calendar-type": firstCalendar.type,
        data: {},
      },
      fileId:
        typeof firstCalendar["data-file-id"] === "string" ? firstCalendar["data-file-id"].trim() : "",
    });
    firstCalendar["data-file-id"] = createResult.fileId;

    await updateDriveJsonFile(cliConfig, {
      fileId: configMeta.id,
      payload: normalized.config,
    });
  }

  return {
    folderId,
    configFileId: configMeta.id,
    configPayload: normalized.config,
  };
}

function resolveCurrentAccount(configPayload) {
  if (!isObjectRecord(configPayload.accounts)) {
    throw new Error("Invalid justcalendar.json: missing accounts object.");
  }
  const currentAccountId =
    typeof configPayload["current-account-id"] === "string" && configPayload["current-account-id"].trim()
      ? configPayload["current-account-id"].trim()
      : "";

  if (!currentAccountId || !isObjectRecord(configPayload.accounts[currentAccountId])) {
    throw new Error("Invalid justcalendar.json: missing current account.");
  }

  const currentAccount = configPayload.accounts[currentAccountId];
  if (!Array.isArray(currentAccount.calendars)) {
    throw new Error("Invalid justcalendar.json: current account has no calendars array.");
  }

  return {
    currentAccountId,
    currentAccount,
  };
}

function resolveCalendarFromSelector(account, selector) {
  const calendarSelector = String(selector ?? "").trim();
  if (!calendarSelector) {
    throw new Error("Calendar selector is required.");
  }

  const calendars = Array.isArray(account.calendars) ? account.calendars : [];
  const byId = calendars.find((calendar) => isObjectRecord(calendar) && calendar.id === calendarSelector);
  if (byId) {
    return byId;
  }

  const byName = calendars.filter(
    (calendar) =>
      isObjectRecord(calendar) &&
      typeof calendar.name === "string" &&
      calendar.name.trim().toLowerCase() === calendarSelector.toLowerCase(),
  );

  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    const ids = byName.map((calendar) => calendar.id).join(", ");
    throw new Error(`Calendar name is ambiguous. Matching ids: ${ids}`);
  }

  throw new Error(`Calendar not found: ${calendarSelector}`);
}

function parseIsoDay(dateInput) {
  const rawDate = String(dateInput ?? "").trim();
  const dateMatch = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    throw new Error("Date must use YYYY-MM-DD format.");
  }

  const [_, year, month, day] = dateMatch;
  const monthNumber = Number(month);
  const dayNumber = Number(day);

  const candidate = new Date(Date.UTC(Number(year), monthNumber - 1, dayNumber));
  const isValidDate =
    candidate.getUTCFullYear() === Number(year) &&
    candidate.getUTCMonth() + 1 === monthNumber &&
    candidate.getUTCDate() === dayNumber;
  if (!isValidDate) {
    throw new Error(`Invalid date: ${rawDate}`);
  }

  return `${year}-${month}-${day}`;
}

function parseBooleanLikeValue(rawValue) {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "checked"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "unchecked", "none", "clear", "unset"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${rawValue}. Use true/false.`);
}

function parseDayValueForCalendar(calendar, rawValue) {
  const calendarType = normalizeCalendarType(calendar?.type, "check");

  if (calendarType === "score") {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) {
      throw new Error("Score value must be a number between -1 and 10.");
    }
    const rounded = Math.round(numeric);
    if (rounded < -1 || rounded > 10) {
      throw new Error("Score value must be between -1 and 10.");
    }
    if (rounded === -1) {
      return { unset: true, value: null };
    }
    return { unset: false, value: rounded };
  }

  if (calendarType === "check") {
    const boolValue = parseBooleanLikeValue(rawValue);
    if (!boolValue) {
      return { unset: true, value: null };
    }
    return { unset: false, value: true };
  }

  if (calendarType === "notes") {
    const noteValue = String(rawValue ?? "");
    if (!noteValue.trim()) {
      return { unset: true, value: null };
    }
    return { unset: false, value: noteValue };
  }

  const signalValue = String(rawValue ?? "").trim().toLowerCase();
  if (["clear", "unset", "none"].includes(signalValue)) {
    return { unset: true, value: null };
  }
  if (!SIGNAL_DAY_VALUES.has(signalValue)) {
    throw new Error("Signal value must be one of: red, yellow, green, x, clear.");
  }
  return { unset: false, value: signalValue };
}

async function loadCalendarDataFile(cliConfig, workspace, accountId, calendar) {
  const fileName =
    typeof calendar["data-file"] === "string" && calendar["data-file"].trim()
      ? calendar["data-file"].trim()
      : `${accountId}_${calendar.id}.json`;

  let fileId = typeof calendar["data-file-id"] === "string" ? calendar["data-file-id"].trim() : "";

  if (fileId) {
    const byId = await readDriveJsonFileById(cliConfig, fileId);
    if (byId.found) {
      const payload = byId.payload;
      const flatData = flattenNestedDayData(payload.data);
      return {
        fileId,
        fileName,
        payload,
        flatData,
        configNeedsSave: false,
      };
    }
    fileId = "";
  }

  const byName = await findFileByNameInFolder(cliConfig, {
    folderId: workspace.folderId,
    fileName,
  });

  if (byName?.id) {
    fileId = byName.id;
    const readResult = await readDriveJsonFileById(cliConfig, fileId);
    if (!readResult.found) {
      fileId = "";
    } else {
      const payload = readResult.payload;
      return {
        fileId,
        fileName,
        payload,
        flatData: flattenNestedDayData(payload.data),
        configNeedsSave: calendar["data-file-id"] !== fileId,
      };
    }
  }

  const created = await createDriveJsonFile(cliConfig, {
    folderId: workspace.folderId,
    fileName,
    payload: {
      version: 1,
      "account-id": accountId,
      "calendar-id": calendar.id,
      "calendar-type": normalizeCalendarType(calendar.type, "check"),
      data: {},
    },
  });

  return {
    fileId: created.fileId,
    fileName,
    payload: {
      version: 1,
      "account-id": accountId,
      "calendar-id": calendar.id,
      "calendar-type": normalizeCalendarType(calendar.type, "check"),
      data: {},
    },
    flatData: {},
    configNeedsSave: true,
  };
}

async function saveWorkspaceConfig(cliConfig, workspace) {
  await updateDriveJsonFile(cliConfig, {
    fileId: workspace.configFileId,
    payload: workspace.configPayload,
  });
}

function formatEpochMs(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) {
    return "unknown";
  }
  return new Date(Number(ms)).toISOString();
}

function printCalendarLine(calendar, { currentCalendarId = "" } = {}) {
  const isCurrent = calendar.id === currentCalendarId ? "*" : " ";
  const scoreDisplayText = calendar.type === "score" ? ` display=${calendar.display || "number"}` : "";
  const pinnedText = calendar.pinned ? " pinned=true" : "";
  console.log(
    `${isCurrent} ${calendar.name} (id=${calendar.id}, type=${calendar.type}, color=${calendar.color}${pinnedText}${scoreDisplayText})`,
  );
}

async function runLoginCommand(options = {}) {
  const token = normalizeAgentToken(options.token || "");
  if (!token) {
    throw new Error("Invalid token. Expected format like jca_<...>.");
  }

  const cliConfig = await readCliConfig();
  cliConfig.baseUrl = normalizeBaseUrl(options.url || cliConfig.baseUrl || DEFAULT_BASE_URL);
  cliConfig.agentToken = token;
  clearCachedAccessToken(cliConfig);
  await writeCliConfig(cliConfig);

  const tokenResult = await ensureBackendAccessToken(cliConfig, { forceRefresh: true });
  console.log("Login successful.");
  console.log(`Backend: ${cliConfig.baseUrl}`);
  console.log(`Access token expires: ${formatEpochMs(tokenResult.expiresAt)}`);
}

async function runLogoutCommand() {
  const cliConfig = await readCliConfig();
  cliConfig.agentToken = "";
  clearCachedAccessToken(cliConfig);
  await writeCliConfig(cliConfig);
  console.log("Logged out locally from justcalendar-cli.");
}

async function runStatusCommand() {
  const cliConfig = await readCliConfig();
  console.log(`Backend: ${cliConfig.baseUrl || DEFAULT_BASE_URL}`);
  console.log(`Agent token configured: ${normalizeAgentToken(cliConfig.agentToken || "") ? "yes" : "no"}`);

  if (!normalizeAgentToken(cliConfig.agentToken || "")) {
    return;
  }

  try {
    const tokenState = await ensureBackendAccessToken(cliConfig);
    console.log(`Access token valid until: ${formatEpochMs(tokenState.expiresAt)}`);

    const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: false });
    const { currentAccountId, currentAccount } = resolveCurrentAccount(workspace.configPayload);
    const currentCalendarId =
      typeof workspace.configPayload["current-calendar-id"] === "string"
        ? workspace.configPayload["current-calendar-id"].trim()
        : "";

    console.log(`Current account: ${currentAccount.name} (id=${currentAccountId})`);
    console.log(`Calendars: ${currentAccount.calendars.length}`);
    for (const calendar of currentAccount.calendars) {
      printCalendarLine(calendar, { currentCalendarId });
    }
  } catch (error) {
    console.log(`Status check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCalendarsListCommand() {
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccountId, currentAccount } = resolveCurrentAccount(workspace.configPayload);
  const currentCalendarId =
    typeof workspace.configPayload["current-calendar-id"] === "string"
      ? workspace.configPayload["current-calendar-id"].trim()
      : "";

  console.log(`Account: ${currentAccount.name} (id=${currentAccountId})`);
  for (const calendar of currentAccount.calendars) {
    printCalendarLine(calendar, { currentCalendarId });
  }
}

async function runCalendarsAddCommand(name, options = {}) {
  const calendarName = normalizeName(name, "Unnamed");
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccountId, currentAccount } = resolveCurrentAccount(workspace.configPayload);

  const hasSameName = currentAccount.calendars.some(
    (calendar) =>
      isObjectRecord(calendar) &&
      typeof calendar.name === "string" &&
      calendar.name.trim().toLowerCase() === calendarName.toLowerCase(),
  );
  if (hasSameName) {
    throw new Error(`A calendar named \"${calendarName}\" already exists.`);
  }

  const usedIds = new Set(
    currentAccount.calendars
      .map((calendar) => (isObjectRecord(calendar) && typeof calendar.id === "string" ? calendar.id.trim() : ""))
      .filter(Boolean),
  );

  let calendarId = createHighEntropyId();
  while (usedIds.has(calendarId)) {
    calendarId = createHighEntropyId();
  }

  const calendarType = normalizeCalendarType(options.type || "check", "check");
  const calendarColor = normalizeCalendarColor(options.color || "blue", "blue");
  const calendarDisplay = normalizeScoreDisplay(options.display || "number", "number");
  const calendarDataFile = `${currentAccountId}_${calendarId}.json`;

  const newCalendar = {
    id: calendarId,
    name: calendarName,
    type: calendarType,
    color: calendarColor,
    pinned: Boolean(options.pinned),
    "data-file": calendarDataFile,
    ...(calendarType === "score" ? { display: calendarDisplay } : {}),
  };

  const createDataResult = await createDriveJsonFile(cliConfig, {
    folderId: workspace.folderId,
    fileName: calendarDataFile,
    payload: {
      version: 1,
      "account-id": currentAccountId,
      "calendar-id": calendarId,
      "calendar-type": calendarType,
      data: {},
    },
  });
  newCalendar["data-file-id"] = createDataResult.fileId;

  currentAccount.calendars.push(newCalendar);

  const currentCalendarId =
    typeof workspace.configPayload["current-calendar-id"] === "string"
      ? workspace.configPayload["current-calendar-id"].trim()
      : "";
  if (!currentCalendarId) {
    workspace.configPayload["current-calendar-id"] = calendarId;
  }

  await saveWorkspaceConfig(cliConfig, workspace);

  console.log(`Created calendar \"${calendarName}\".`);
  console.log(`id=${calendarId} type=${calendarType} color=${calendarColor}`);
}

async function runCalendarsRenameCommand(selector, newName) {
  const nextName = normalizeName(newName, "Unnamed");
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccount } = resolveCurrentAccount(workspace.configPayload);

  const targetCalendar = resolveCalendarFromSelector(currentAccount, selector);
  const hasConflict = currentAccount.calendars.some(
    (calendar) =>
      calendar !== targetCalendar &&
      isObjectRecord(calendar) &&
      typeof calendar.name === "string" &&
      calendar.name.trim().toLowerCase() === nextName.toLowerCase(),
  );
  if (hasConflict) {
    throw new Error(`Another calendar already uses name \"${nextName}\".`);
  }

  const previousName = targetCalendar.name;
  targetCalendar.name = nextName;
  await saveWorkspaceConfig(cliConfig, workspace);

  console.log(`Renamed calendar \"${previousName}\" -> \"${nextName}\".`);
}

async function runCalendarsRemoveCommand(selector) {
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccount } = resolveCurrentAccount(workspace.configPayload);

  if (currentAccount.calendars.length <= 1) {
    throw new Error("Cannot remove the last calendar.");
  }

  const targetCalendar = resolveCalendarFromSelector(currentAccount, selector);
  const targetIndex = currentAccount.calendars.indexOf(targetCalendar);
  if (targetIndex < 0) {
    throw new Error("Calendar could not be removed because it was not found.");
  }

  currentAccount.calendars.splice(targetIndex, 1);

  const currentCalendarId =
    typeof workspace.configPayload["current-calendar-id"] === "string"
      ? workspace.configPayload["current-calendar-id"].trim()
      : "";
  if (currentCalendarId === targetCalendar.id) {
    workspace.configPayload["current-calendar-id"] = currentAccount.calendars[0].id;
  }

  await saveWorkspaceConfig(cliConfig, workspace);

  const dataFileId =
    typeof targetCalendar["data-file-id"] === "string" ? targetCalendar["data-file-id"].trim() : "";
  const dataFileName =
    typeof targetCalendar["data-file"] === "string" && targetCalendar["data-file"].trim()
      ? targetCalendar["data-file"].trim()
      : "";

  if (dataFileId) {
    await deleteDriveFileById(cliConfig, dataFileId);
  } else if (dataFileName) {
    const existing = await findFileByNameInFolder(cliConfig, {
      folderId: workspace.folderId,
      fileName: dataFileName,
    });
    if (existing?.id) {
      await deleteDriveFileById(cliConfig, existing.id);
    }
  }

  console.log(`Removed calendar \"${targetCalendar.name}\" (id=${targetCalendar.id}).`);
}

async function runCalendarsSelectCommand(selector) {
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccount } = resolveCurrentAccount(workspace.configPayload);
  const targetCalendar = resolveCalendarFromSelector(currentAccount, selector);

  workspace.configPayload["current-calendar-id"] = targetCalendar.id;
  await saveWorkspaceConfig(cliConfig, workspace);

  console.log(`Selected calendar \"${targetCalendar.name}\" (id=${targetCalendar.id}).`);
}

async function runDataSetCommand(selector, dateInput, valueInput) {
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccountId, currentAccount } = resolveCurrentAccount(workspace.configPayload);
  const targetCalendar = resolveCalendarFromSelector(currentAccount, selector);
  const dateKey = parseIsoDay(dateInput);

  const dataFileState = await loadCalendarDataFile(cliConfig, workspace, currentAccountId, targetCalendar);
  const parsedValue = parseDayValueForCalendar(targetCalendar, valueInput);

  if (parsedValue.unset) {
    delete dataFileState.flatData[dateKey];
  } else {
    dataFileState.flatData[dateKey] = parsedValue.value;
  }

  const nextPayload = {
    version: 1,
    "account-id": currentAccountId,
    "calendar-id": targetCalendar.id,
    "calendar-type": normalizeCalendarType(targetCalendar.type, "check"),
    data: toNestedDayData(dataFileState.flatData),
  };

  const writeResult = await upsertDriveJsonFileByName(cliConfig, {
    folderId: workspace.folderId,
    fileName: dataFileState.fileName,
    payload: nextPayload,
    fileId: dataFileState.fileId,
  });

  targetCalendar["data-file"] = dataFileState.fileName;
  targetCalendar["data-file-id"] = writeResult.fileId;
  if (dataFileState.configNeedsSave) {
    await saveWorkspaceConfig(cliConfig, workspace);
  }

  if (parsedValue.unset) {
    console.log(`Cleared ${dateKey} for calendar \"${targetCalendar.name}\".`);
  } else {
    console.log(`Set ${dateKey}=${JSON.stringify(parsedValue.value)} for calendar \"${targetCalendar.name}\".`);
  }
}

async function runDataDeleteCommand(selector, dateInput) {
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccountId, currentAccount } = resolveCurrentAccount(workspace.configPayload);
  const targetCalendar = resolveCalendarFromSelector(currentAccount, selector);
  const dateKey = parseIsoDay(dateInput);

  const dataFileState = await loadCalendarDataFile(cliConfig, workspace, currentAccountId, targetCalendar);
  delete dataFileState.flatData[dateKey];

  const nextPayload = {
    version: 1,
    "account-id": currentAccountId,
    "calendar-id": targetCalendar.id,
    "calendar-type": normalizeCalendarType(targetCalendar.type, "check"),
    data: toNestedDayData(dataFileState.flatData),
  };

  const writeResult = await upsertDriveJsonFileByName(cliConfig, {
    folderId: workspace.folderId,
    fileName: dataFileState.fileName,
    payload: nextPayload,
    fileId: dataFileState.fileId,
  });

  targetCalendar["data-file"] = dataFileState.fileName;
  targetCalendar["data-file-id"] = writeResult.fileId;
  if (dataFileState.configNeedsSave) {
    await saveWorkspaceConfig(cliConfig, workspace);
  }

  console.log(`Deleted day value ${dateKey} from calendar \"${targetCalendar.name}\".`);
}

async function runDataGetCommand(selector, dateInput) {
  const cliConfig = await readCliConfig();
  requireAgentToken(cliConfig);

  const workspace = await loadWorkspace(cliConfig, { createConfigIfMissing: true });
  const { currentAccountId, currentAccount } = resolveCurrentAccount(workspace.configPayload);
  const targetCalendar = resolveCalendarFromSelector(currentAccount, selector);
  const dateKey = parseIsoDay(dateInput);

  const dataFileState = await loadCalendarDataFile(cliConfig, workspace, currentAccountId, targetCalendar);
  const value = Object.prototype.hasOwnProperty.call(dataFileState.flatData, dateKey)
    ? dataFileState.flatData[dateKey]
    : null;

  if (value === null) {
    console.log(`${targetCalendar.name} ${dateKey}: <empty>`);
    return;
  }

  console.log(`${targetCalendar.name} ${dateKey}: ${JSON.stringify(value)}`);
}

function printFatalErrorAndExit(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

export async function runCli(argv = process.argv) {
  const program = new Command();

  program
    .name("justcalendar")
    .description("CLI for managing Just Calendar data in Google Drive")
    .version("0.1.0");

  program
    .command("login")
    .description("Save your agent token and validate access with backend")
    .requiredOption("-t, --token <token>", "Agent token generated from the website popup")
    .option("-u, --url <url>", "Just Calendar backend URL", DEFAULT_BASE_URL)
    .action(async (options) => {
      try {
        await runLoginCommand(options);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  program
    .command("logout")
    .description("Clear local CLI login state")
    .action(async () => {
      try {
        await runLogoutCommand();
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  program
    .command("status")
    .description("Show CLI auth status and current calendars")
    .action(async () => {
      try {
        await runStatusCommand();
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  const calendars = program.command("calendars").description("Manage calendars");

  calendars
    .command("list")
    .description("List calendars in current account")
    .action(async () => {
      try {
        await runCalendarsListCommand();
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  calendars
    .command("add <name>")
    .description("Add a new calendar")
    .option("--type <type>", "Calendar type: signal-3|score|check|notes", "check")
    .option("--color <color>", "Calendar color", "blue")
    .option("--display <display>", "Score display: number|heatmap|number-heatmap", "number")
    .option("--pinned", "Pin calendar", false)
    .action(async (name, options) => {
      try {
        await runCalendarsAddCommand(name, options);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  calendars
    .command("rename <calendar> <newName>")
    .description("Rename a calendar by id or name")
    .action(async (calendar, newName) => {
      try {
        await runCalendarsRenameCommand(calendar, newName);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  calendars
    .command("remove <calendar>")
    .description("Remove a calendar by id or name")
    .action(async (calendar) => {
      try {
        await runCalendarsRemoveCommand(calendar);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  calendars
    .command("select <calendar>")
    .description("Set current selected calendar by id or name")
    .action(async (calendar) => {
      try {
        await runCalendarsSelectCommand(calendar);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  const data = program.command("data").description("Manage day data values");

  data
    .command("set <calendar> <date> <value>")
    .description("Set a day value. Date format: YYYY-MM-DD")
    .action(async (calendar, date, value) => {
      try {
        await runDataSetCommand(calendar, date, value);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  data
    .command("delete <calendar> <date>")
    .description("Delete/clear a day value. Date format: YYYY-MM-DD")
    .action(async (calendar, date) => {
      try {
        await runDataDeleteCommand(calendar, date);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  data
    .command("get <calendar> <date>")
    .description("Read a day value. Date format: YYYY-MM-DD")
    .action(async (calendar, date) => {
      try {
        await runDataGetCommand(calendar, date);
      } catch (error) {
        printFatalErrorAndExit(error);
      }
    });

  await program.parseAsync(argv);
}
